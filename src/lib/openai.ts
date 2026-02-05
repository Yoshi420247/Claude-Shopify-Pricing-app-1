// Server-side OpenAI client with automatic model fallback
// Tries GPT-5.2 first, falls back to gpt-4o if not available

function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  return key;
}

// Model configuration - tracks which model to use
const PREFERRED_MODEL = 'gpt-5.2';
const FALLBACK_MODEL = 'gpt-4o';
let activeModel = PREFERRED_MODEL;
let modelFallbackTriggered = false;

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
  const model = options.model || activeModel;

  try {
    return await makeRequest(key, model, options);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Check if it's a model access error - try fallback
    if (!modelFallbackTriggered && model === PREFERRED_MODEL &&
        (errorMsg.includes('model_not_found') ||
         errorMsg.includes('does not have access') ||
         errorMsg.includes('invalid_model') ||
         errorMsg.includes('404'))) {
      console.warn(`GPT-5.2 not available, falling back to ${FALLBACK_MODEL}`);
      modelFallbackTriggered = true;
      activeModel = FALLBACK_MODEL;
      return await makeRequest(key, FALLBACK_MODEL, options);
    }

    throw error;
  }
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
    body.max_completion_tokens = options.maxTokens || 4000;

    if (isGPT5 && options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
    }

    if (isGPT5 && options.jsonMode) {
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

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  // Handle API errors
  if (!res.ok || data.error) {
    const errorMsg = data.error?.message || `HTTP ${res.status}`;
    const errorCode = data.error?.code || '';
    throw new Error(`${errorMsg} (${errorCode})`);
  }

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    // Log for debugging
    console.error('OpenAI empty response:', JSON.stringify({
      model,
      finishReason: data.choices?.[0]?.finish_reason,
      usage: data.usage,
      hasChoices: !!data.choices?.length,
    }));

    const refusal = data.choices?.[0]?.message?.refusal;
    if (refusal) {
      throw new Error(`AI refused: ${refusal}`);
    }

    const finishReason = data.choices?.[0]?.finish_reason;
    if (finishReason === 'length') {
      throw new Error('Response truncated (increase max_tokens)');
    }
    if (finishReason === 'content_filter') {
      throw new Error('Response blocked by content filter');
    }

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

// Test OpenAI connection and check model availability
export async function testOpenAIConnection() {
  try {
    const key = getOpenAIKey();

    // Test with a simple completion
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: activeModel,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 5,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      // If preferred model fails, try fallback
      if (activeModel === PREFERRED_MODEL) {
        const fallbackRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: FALLBACK_MODEL,
            messages: [{ role: 'user', content: 'Say "ok"' }],
            max_tokens: 5,
          }),
        });

        if (fallbackRes.ok) {
          activeModel = FALLBACK_MODEL;
          modelFallbackTriggered = true;
          return { success: true, model: FALLBACK_MODEL, note: 'Using fallback model' };
        }
      }

      return { success: false, error: data.error?.message || `HTTP ${res.status}` };
    }

    return { success: true, model: activeModel };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: message };
  }
}

// Get current active model
export function getActiveModel(): string {
  return activeModel;
}
