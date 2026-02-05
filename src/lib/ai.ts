// Unified AI interface supporting OpenAI GPT-5.2 and Anthropic Claude Opus 4.5
// Automatically routes requests to the configured provider

import * as openaiClient from './openai';
import * as anthropicClient from './anthropic';
import type { ChatMessage as OpenAIChatMessage } from './openai';
import type { ContentBlock as AnthropicContentBlock } from './anthropic';

export type AIProvider = 'openai' | 'anthropic';
export type AIModel = 'gpt-5.2' | 'claude-opus-4.5';

// Map user-friendly model names to actual model IDs
const MODEL_MAP: Record<AIModel, { provider: AIProvider; modelId: string }> = {
  'gpt-5.2': { provider: 'openai', modelId: 'gpt-5.2' },
  'claude-opus-4.5': { provider: 'anthropic', modelId: 'claude-opus-4-5-20251101' },
};

// Map reasoning effort to thinking budget for Anthropic
const THINKING_BUDGET_MAP: Record<string, number> = {
  none: 0,
  low: 5000,
  medium: 10000,
  high: 20000,
  xhigh: 40000,
};

interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | AIContentPart[];
}

interface AIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail: 'high' | 'low' | 'auto' };
}

interface AICompletionOptions {
  model: AIModel;
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}

// Convert OpenAI-style messages to Anthropic format
function convertToAnthropicMessages(messages: AIMessage[]): {
  system: string | undefined;
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>;
} {
  let system: string | undefined;
  const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Anthropic uses top-level system param
      system = typeof msg.content === 'string' ? msg.content : msg.content.map(c => c.text || '').join('\n');
      continue;
    }

    const role = msg.role as 'user' | 'assistant';

    if (typeof msg.content === 'string') {
      anthropicMessages.push({ role, content: msg.content });
    } else {
      // Convert content parts
      const blocks: AnthropicContentBlock[] = msg.content.map(part => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text };
        } else if (part.type === 'image_url' && part.image_url?.url) {
          // Anthropic supports URL images in claude-opus-4-5
          return {
            type: 'image' as const,
            source: {
              type: 'url' as const,
              url: part.image_url.url,
            },
          };
        }
        return { type: 'text' as const, text: '' };
      }).filter(b => b.type === 'text' ? !!b.text : true);

      anthropicMessages.push({ role, content: blocks });
    }
  }

  return { system, messages: anthropicMessages };
}

// Add JSON instruction to system prompt for providers without native JSON mode
function addJsonInstruction(system: string | undefined, enabled: boolean): string | undefined {
  if (!enabled) return system;
  const jsonInst = '\n\nIMPORTANT: You must respond with valid JSON only. No markdown formatting, no explanation text before or after the JSON.';
  return system ? system + jsonInst : jsonInst.trim();
}

export async function chatCompletion(options: AICompletionOptions): Promise<string> {
  const config = MODEL_MAP[options.model];
  if (!config) {
    throw new Error(`Unknown model: ${options.model}. Supported: ${Object.keys(MODEL_MAP).join(', ')}`);
  }

  const { provider, modelId } = config;

  if (provider === 'openai') {
    // Route to OpenAI
    return openaiClient.chatCompletion({
      model: modelId,
      messages: options.messages as OpenAIChatMessage[],
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      jsonMode: options.jsonMode,
      reasoningEffort: options.reasoningEffort,
    });
  } else {
    // Route to Anthropic
    const { system, messages } = convertToAnthropicMessages(options.messages);

    // Determine if we should use extended thinking
    const useThinking = options.reasoningEffort && options.reasoningEffort !== 'none';
    const thinkingBudget = options.reasoningEffort ? THINKING_BUDGET_MAP[options.reasoningEffort] : 0;

    return anthropicClient.chatCompletion({
      model: modelId,
      messages,
      system: addJsonInstruction(system, !!options.jsonMode),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      extendedThinking: useThinking,
      thinkingBudget: thinkingBudget > 0 ? thinkingBudget : undefined,
    });
  }
}

// Re-export the JSON parser (same implementation works for both)
export { parseAIJson } from './openai';

// Test connection for a specific model
export async function testConnection(model: AIModel) {
  const config = MODEL_MAP[model];
  if (!config) {
    return { success: false, model, error: `Unknown model: ${model}` };
  }

  if (config.provider === 'openai') {
    return openaiClient.testOpenAIConnection(config.modelId);
  } else {
    return anthropicClient.testAnthropicConnection(config.modelId);
  }
}

// Get available models
export function getAvailableModels(): AIModel[] {
  return Object.keys(MODEL_MAP) as AIModel[];
}

// Get provider for a model
export function getProviderForModel(model: AIModel): AIProvider {
  return MODEL_MAP[model]?.provider || 'openai';
}

// Check if API key is configured for a provider
export function isProviderConfigured(provider: AIProvider): boolean {
  if (provider === 'openai') {
    return !!process.env.OPENAI_API_KEY;
  } else {
    return !!process.env.ANTHROPIC_API_KEY;
  }
}
