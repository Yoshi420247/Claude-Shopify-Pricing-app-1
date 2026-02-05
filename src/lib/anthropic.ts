// Server-side Anthropic client for Claude Opus 4.5
// High-capability model with extended thinking

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-5-20251101';
const API_VERSION = '2023-06-01';

function getAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  return key;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  extendedThinking?: boolean;
  thinkingBudget?: number; // tokens for thinking (min 1024)
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: 'text' | 'thinking';
    text?: string;
    thinking?: string;
  }>;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
  const key = getAnthropicKey();
  const model = options.model || DEFAULT_MODEL;

  // Retry logic for transient failures
  let lastError: Error | null = null;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await makeRequest(key, model, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorMsg = lastError.message;

      // Don't retry on definitive errors
      if (errorMsg.includes('invalid_api_key') ||
          errorMsg.includes('authentication') ||
          errorMsg.includes('model_not_found') ||
          errorMsg.includes('content_policy')) {
        throw lastError;
      }

      // Retry on transient errors
      if (attempt < maxRetries &&
          (errorMsg.includes('overloaded') ||
           errorMsg.includes('timeout') ||
           errorMsg.includes('529') ||
           errorMsg.includes('rate_limit'))) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.warn(`Anthropic attempt ${attempt + 1} failed: ${errorMsg}. Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error('Anthropic request failed after retries');
}

async function makeRequest(
  key: string,
  model: string,
  options: ChatCompletionOptions
): Promise<string> {
  const isOpus45 = model.includes('opus-4-5') || model.includes('opus-4.5');

  // Build request body
  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    max_tokens: options.maxTokens || 4096,
  };

  // Add system prompt if provided
  if (options.system) {
    body.system = options.system;
  }

  // Temperature (not compatible with extended thinking)
  if (!options.extendedThinking && options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  // Extended thinking for Opus 4.5
  if (options.extendedThinking && isOpus45) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: options.thinkingBudget || 10000,
    };
  }

  // Headers
  const headers: Record<string, string> = {
    'x-api-key': key,
    'Content-Type': 'application/json',
    'anthropic-version': API_VERSION,
  };

  // Beta header for extended thinking
  if (options.extendedThinking && isOpus45) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-01-24';
  }

  // Log request for debugging
  console.log('Anthropic request:', JSON.stringify({
    model,
    maxTokens: body.max_tokens,
    extendedThinking: !!options.extendedThinking,
    thinkingBudget: options.thinkingBudget,
    messageCount: options.messages.length,
  }));

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000), // 3 minute timeout for thinking
  });

  let data: AnthropicResponse;
  try {
    data = await res.json() as AnthropicResponse;
  } catch {
    throw new Error(`Failed to parse Anthropic response: HTTP ${res.status}`);
  }

  // Handle API errors
  if (!res.ok) {
    const errorData = data as unknown as { error?: { type?: string; message?: string } };
    const errorType = errorData.error?.type || 'unknown';
    const errorMsg = errorData.error?.message || `HTTP ${res.status}`;
    console.error('Anthropic API error:', { status: res.status, error: errorData.error });
    throw new Error(`${errorMsg} (${errorType})`);
  }

  // Extract text content (skip thinking blocks)
  const textBlocks = data.content.filter(c => c.type === 'text');
  const content = textBlocks.map(c => c.text || '').join('\n').trim();

  // Log usage for monitoring
  console.log('Anthropic response:', JSON.stringify({
    model: data.model,
    stopReason: data.stop_reason,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
    hasContent: !!content,
    contentLength: content.length,
    thinkingBlocks: data.content.filter(c => c.type === 'thinking').length,
  }));

  if (!content) {
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Response truncated (increase max_tokens)');
    }
    throw new Error(`Empty response (stop_reason: ${data.stop_reason || 'unknown'})`);
  }

  return content;
}

// Parse JSON from AI response with robust error handling
export function parseAIJson<T>(raw: string): T {
  if (!raw || raw.trim() === '') {
    throw new Error('Empty response from AI');
  }

  let cleaned = raw.trim();

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Extract JSON object from text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  // Fix common issues
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1'); // trailing commas

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('JSON parse error. First 500 chars:', raw.substring(0, 500));
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
  }
}

// Test Anthropic connection
export async function testAnthropicConnection(model?: string) {
  const testModel = model || DEFAULT_MODEL;
  try {
    const key = getAnthropicKey();

    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'Content-Type': 'application/json',
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json() as AnthropicResponse;

    if (!res.ok) {
      const errorData = data as unknown as { error?: { message?: string } };
      return {
        success: false,
        model: testModel,
        error: errorData.error?.message || `HTTP ${res.status}`,
      };
    }

    const content = data.content?.find(c => c.type === 'text')?.text;

    return {
      success: true,
      model: testModel,
      response: content,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, model: testModel, error: message };
  }
}

// Get default model
export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}
