// Server-side OpenAI client using GPT-5.2 with reasoning

function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  return key;
}

// Default to gpt-5.2 with high reasoning. Users with Pro access can set gpt-5.2-pro.
const DEFAULT_MODEL = 'gpt-5.2';
const REASONING_EFFORT = 'high';

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
  const reasoningEffort = options.reasoningEffort || REASONING_EFFORT;

  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    max_tokens: options.maxTokens || 4000,
  };

  // GPT-5.2 uses reasoning.effort instead of temperature
  if (model.startsWith('gpt-5')) {
    body.reasoning = { effort: reasoningEffort };
    // JSON mode via response_format
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
  } else {
    // Fallback for older models
    body.temperature = options.temperature || 0.4;
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

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    throw new Error(err.error?.message || `OpenAI error: ${res.status}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// Parse JSON from AI response, handling markdown code blocks
export function parseAIJson<T>(raw: string): T {
  let cleaned = raw.trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned);
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
