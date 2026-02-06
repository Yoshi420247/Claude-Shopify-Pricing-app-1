// Server-side OpenAI client using GPT-5.2 (most capable model)

import { openaiRateLimiter } from './rate-limiter';

function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  return key;
}

// Use GPT-5.2 as default - best reasoning and vision capabilities
const DEFAULT_MODEL = 'gpt-5.2';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail: 'high' | 'low' | 'auto' };
}

interface ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
  const key = getOpenAIKey();
  const model = options.model || DEFAULT_MODEL;

  // GPT-5.x and o1 models use max_completion_tokens
  const isGPT5 = model.startsWith('gpt-5');
  const isO1Model = model.startsWith('o1');
  const useNewParams = isGPT5 || isO1Model;

  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
  };

  if (useNewParams) {
    // GPT-5.x uses max_completion_tokens
    body.max_completion_tokens = options.maxTokens || 4000;

    // GPT-5.2 supports reasoning_effort parameter (top-level for Chat Completions API)
    if (isGPT5 && options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
    }

    // GPT-5.x supports JSON mode
    if (isGPT5 && options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    // o1 doesn't support temperature or response_format
  } else {
    // Legacy models (GPT-4, etc)
    body.max_tokens = options.maxTokens || 4000;
    body.temperature = options.temperature ?? 0.3;
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
  }

  // Retry wrapper for transient failures (empty responses, timeouts)
  const MAX_EMPTY_RETRIES = 2;
  let lastError: Error | null = null;

  for (let emptyRetry = 0; emptyRetry <= MAX_EMPTY_RETRIES; emptyRetry++) {
    try {
      const content = await openaiRateLimiter.execute(async () => {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
          throw new Error(err.error?.message || `OpenAI error: ${res.status}`);
        }

        const data = await res.json();
        const text = data.choices[0]?.message?.content;

        if (!text) {
          const refusal = data.choices[0]?.message?.refusal;
          if (refusal) {
            throw new Error(`AI refused: ${refusal}`);
          }
          throw new Error('AI returned empty response');
        }

        return text;
      }, 3);

      return content;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // Only retry on empty responses or timeouts, not on refusals or quota errors
      const msg = lastError.message.toLowerCase();
      const isRetryable = msg.includes('empty response') || msg.includes('timeout') || msg.includes('econnreset');
      if (isRetryable && emptyRetry < MAX_EMPTY_RETRIES) {
        const backoff = (emptyRetry + 1) * 2000;
        console.log(`[openai] Empty/timeout response, retry ${emptyRetry + 1}/${MAX_EMPTY_RETRIES} after ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('AI returned empty response');
}

// Attempt to fix truncated JSON by closing unclosed braces/brackets/strings
function tryFixTruncatedJson(str: string): string {
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
  }

  // If we're in a string, close it
  if (inString) str += '"';

  // Remove trailing partial value (e.g., "key": tru or "key": "partial)
  str = str.replace(/,\s*"[^"]*"\s*:\s*(?:[^,}\]"]*|"[^"]*)?$/, '');
  str = str.replace(/,\s*$/, '');

  // Close open brackets and braces
  while (openBrackets > 0) { str += ']'; openBrackets--; }
  while (openBraces > 0) { str += '}'; openBraces--; }

  return str;
}

// Parse JSON from AI response, handling markdown code blocks, truncation, and common issues
export function parseAIJson<T>(raw: string): T {
  if (!raw || raw.trim() === '') {
    throw new Error('Empty response from AI');
  }

  let cleaned = raw.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Handle case where response might have text before/after JSON
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  // Try to fix common JSON issues
  // 1. Trailing commas
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
  // 2. Single quotes to double quotes (careful with apostrophes)
  cleaned = cleaned.replace(/'([^']+)':/g, '"$1":');

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('JSON parse error. Raw response:', raw.substring(0, 500));

    // Try fixing truncated JSON (common with long responses hitting token limits)
    try {
      const fixed = tryFixTruncatedJson(cleaned);
      return JSON.parse(fixed);
    } catch {
      // Continue to other fallbacks
    }

    // Try to extract the first complete JSON object from the response
    const partialMatch = cleaned.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
    if (partialMatch) {
      try {
        return JSON.parse(partialMatch[0]);
      } catch {
        // Give up
      }
    }

    throw new Error(`Failed to parse AI response as JSON: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }
}

// Test OpenAI connection
export async function testOpenAIConnection() {
  try {
    const key = getOpenAIKey();
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      return { success: true };
    }
    return { success: false, error: `HTTP ${res.status}` };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: message };
  }
}
