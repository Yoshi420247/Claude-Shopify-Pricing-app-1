// Server-side OpenAI client optimized for GPT-5.2
// Robust error handling with detailed logging for debugging

function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  return key;
}

// Model configuration
const DEFAULT_MODEL = 'gpt-5.2';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail: 'high' | 'low' | 'auto' };
}

export interface ChatCompletionOptions {
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
      if (errorMsg.includes('model_not_found') ||
          errorMsg.includes('does not have access') ||
          errorMsg.includes('invalid_model') ||
          errorMsg.includes('AI refused') ||
          errorMsg.includes('content_filter')) {
        throw lastError;
      }

      // Retry on transient/empty response errors
      if (attempt < maxRetries &&
          (errorMsg.includes('Empty response') ||
           errorMsg.includes('network') ||
           errorMsg.includes('timeout') ||
           errorMsg.includes('429'))) {
        const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
        console.warn(`OpenAI attempt ${attempt + 1} failed: ${errorMsg}. Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error('OpenAI request failed after retries');
}

async function makeRequest(
  key: string,
  model: string,
  options: ChatCompletionOptions
): Promise<string> {
  const isGPT5 = model.startsWith('gpt-5');
  const isO1Model = model.startsWith('o1');
  const useNewParams = isGPT5 || isO1Model;

  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
  };

  if (useNewParams) {
    // GPT-5.x and o1 models use max_completion_tokens
    body.max_completion_tokens = options.maxTokens || 4000;

    // GPT-5.x supports reasoning_effort (top-level parameter)
    if (isGPT5 && options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
    }

    // JSON mode for structured output
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
  } else {
    // GPT-4 style params
    body.max_tokens = options.maxTokens || 4000;
    body.temperature = options.temperature ?? 0.3;
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
  }

  // Log request for debugging (redact sensitive data)
  console.log('OpenAI request:', JSON.stringify({
    model,
    maxTokens: body.max_completion_tokens || body.max_tokens,
    reasoningEffort: body.reasoning_effort,
    jsonMode: !!options.jsonMode,
    messageCount: options.messages.length,
  }));

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000), // 2 minute timeout
  });

  let data: Record<string, unknown>;
  try {
    data = await res.json() as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse OpenAI response: HTTP ${res.status}`);
  }

  // Handle API errors
  if (!res.ok || data.error) {
    const err = data.error as Record<string, unknown> | undefined;
    const errorMsg = err?.message || `HTTP ${res.status}`;
    const errorCode = err?.code || '';
    console.error('OpenAI API error:', { status: res.status, error: data.error });
    throw new Error(`${errorMsg} (${errorCode})`);
  }

  // Extract content from response
  const choices = data.choices as Array<{
    message?: { content?: string; refusal?: string };
    finish_reason?: string;
  }> | undefined;

  const content = choices?.[0]?.message?.content;
  const usage = data.usage as Record<string, number> | undefined;

  // Log usage for monitoring
  console.log('OpenAI response:', JSON.stringify({
    model,
    finishReason: choices?.[0]?.finish_reason,
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
    hasContent: !!content,
    contentLength: content?.length || 0,
  }));

  if (!content) {
    const refusal = choices?.[0]?.message?.refusal;
    if (refusal) {
      throw new Error(`AI refused: ${refusal}`);
    }

    const finishReason = choices?.[0]?.finish_reason;
    if (finishReason === 'length') {
      throw new Error('Response truncated (increase max_tokens)');
    }
    if (finishReason === 'content_filter') {
      throw new Error('Response blocked by content filter');
    }

    // Log detailed info for debugging empty responses
    console.error('OpenAI empty response details:', JSON.stringify({
      model,
      finishReason,
      usage,
      hasChoices: !!choices?.length,
      messageKeys: choices?.[0]?.message ? Object.keys(choices[0].message) : [],
      fullResponse: JSON.stringify(data).substring(0, 500),
    }));

    throw new Error(`Empty response (finish_reason: ${finishReason || 'unknown'})`);
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

// Test OpenAI connection with GPT-5.2
export async function testOpenAIConnection(model?: string) {
  const testModel = model || DEFAULT_MODEL;
  try {
    const key = getOpenAIKey();

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_completion_tokens: 10,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const err = data.error as Record<string, unknown> | undefined;
      return {
        success: false,
        model: testModel,
        error: err?.message || `HTTP ${res.status}`,
      };
    }

    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    const content = choices?.[0]?.message?.content;

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
