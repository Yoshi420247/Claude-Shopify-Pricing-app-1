// Google Gemini API client for chat completions and web search
// Drop-in alternative to OpenAI/Claude — same interface, routes to Gemini API
//
// Default model: gemini-2.5-flash (best value — strong reasoning at very low cost)
// Fast model: gemini-2.0-flash (cheapest option, still very capable)
//
// Cost comparison (per 1M tokens):
//   GPT-5.2:          $1.50 input / $3.00 output
//   Claude Sonnet:    $3.00 input / $15.00 output
//   Gemini 2.5 Flash: $0.15 input / $0.60 output (with thinking: $0.70 output)
//   Gemini 2.5 Pro:   $1.25 input / $10.00 output (with thinking: $10.00 output)

import { geminiRateLimiter } from './rate-limiter';
import { parseAIJson } from './openai';
import type { ProductIdentity } from '@/types';
import type { CompetitorPrice, CompetitorSearchResult } from './competitors';

// Known retail smoke shop domains — same list as openai-search.ts
const RETAIL_SMOKE_SHOPS = [
  'smokea.com', 'dankgeek.com', 'everythingfor420.com', 'grasscity.com',
  'dailyhighclub.com', 'brotherswithglass.com', 'smokecartel.com',
  'headshop.com', 'thickassglass.com', 'gogopipes.com', 'kings-pipe.com',
  'tokeplanet.com', 'shopstaywild.com', 'paborito.com', 'stoners.com',
  'badassglass.com', 'dankstop.com', 'hemper.co', 'ssmokeshop.com',
  'worldofbongs.com', 'bongoutlet.com', 'aqualabtechnologies.com',
];

function getGeminiKey(): string {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not configured');
  return key;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';
const FAST_MODEL = 'gemini-2.0-flash';
const SEARCH_MODEL = 'gemini-2.5-flash'; // Use flash for search — cheap + grounding support

// ---------------------------------------------------------------------------
// Shared types — same interface as openai.ts / claude.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Message conversion: OpenAI format → Gemini format
// ---------------------------------------------------------------------------

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

interface GeminiMessage {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Fetch an image URL and convert to base64 for Gemini inline data.
 * Returns null if fetch fails (image will be skipped).
 */
async function fetchImageAsBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'OilSlickPricingBot/1.0' },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim();
    const buffer = await res.arrayBuffer();
    const data = Buffer.from(buffer).toString('base64');

    // Skip if image is too large (>10MB base64)
    if (data.length > 10_000_000) return null;

    return { mimeType, data };
  } catch {
    return null;
  }
}

/**
 * Convert OpenAI-style messages to Gemini format.
 * - System messages → systemInstruction
 * - image_url content parts → inlineData (fetched + base64)
 */
async function convertMessages(messages: ChatMessage[]): Promise<{
  systemInstruction: string;
  geminiMessages: GeminiMessage[];
}> {
  let systemInstruction = '';
  const geminiMessages: GeminiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction += typeof msg.content === 'string' ? msg.content : '';
      continue;
    }

    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

    if (typeof msg.content === 'string') {
      geminiMessages.push({ role, parts: [{ text: msg.content }] });
    } else if (Array.isArray(msg.content)) {
      const parts: GeminiPart[] = [];

      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          parts.push({ text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const imageData = await fetchImageAsBase64(part.image_url.url);
          if (imageData) {
            parts.push({ inlineData: imageData });
          }
        }
      }

      if (parts.length > 0) {
        geminiMessages.push({ role, parts });
      }
    }
  }

  return { systemInstruction, geminiMessages };
}

/**
 * Map reasoning effort to Gemini thinking budget.
 * Gemini 2.5 models support thinkingConfig with a token budget.
 */
function getThinkingConfig(effort: string | undefined, model: string): { thinkingBudget: number } | undefined {
  // Only 2.5 models support thinking
  if (!model.includes('2.5')) return undefined;

  switch (effort) {
    case 'xhigh': return { thinkingBudget: 12288 };
    case 'high': return { thinkingBudget: 8192 };
    case 'medium': return { thinkingBudget: 4096 };
    case 'low': return { thinkingBudget: 1024 };
    default: return undefined; // 'none' or undefined — no thinking
  }
}

// ---------------------------------------------------------------------------
// Chat Completion — same interface as openai.ts / claude.ts
// ---------------------------------------------------------------------------

export async function geminiChatCompletion(options: ChatCompletionOptions): Promise<string> {
  const key = getGeminiKey();
  const model = options.model || DEFAULT_MODEL;
  const { systemInstruction, geminiMessages } = await convertMessages(options.messages);
  const thinking = getThinkingConfig(options.reasoningEffort, model);

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: options.maxTokens || 4000,
  };

  // Temperature (not used when thinking is enabled)
  if (!thinking && options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }

  // JSON mode — Gemini supports responseMimeType
  if (options.jsonMode) {
    generationConfig.responseMimeType = 'application/json';
  }

  const body: Record<string, unknown> = {
    contents: geminiMessages,
    generationConfig,
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  if (thinking) {
    body.generationConfig = {
      ...generationConfig,
      thinkingConfig: thinking,
    };
  }

  const MAX_EMPTY_RETRIES = 2;
  let lastError: Error | null = null;

  for (let emptyRetry = 0; emptyRetry <= MAX_EMPTY_RETRIES; emptyRetry++) {
    try {
      const content = await geminiRateLimiter.execute(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
          throw new Error(err.error?.message || `Gemini error: ${res.status}`);
        }

        const data = await res.json();

        // Extract text from response (skip thinking parts)
        let text = '';
        if (data.candidates?.[0]?.content?.parts) {
          for (const part of data.candidates[0].content.parts) {
            // Skip thinking parts (marked with thought: true)
            if (part.thought) continue;
            if (part.text) {
              text += part.text;
            }
          }
        }

        if (!text) {
          const blockReason = data.candidates?.[0]?.finishReason;
          if (blockReason === 'SAFETY') {
            throw new Error('AI blocked response due to safety filters');
          }
          throw new Error('AI returned empty response');
        }

        return text;
      }, 3);

      return content;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const msg = lastError.message.toLowerCase();
      const isRetryable = msg.includes('empty response') || msg.includes('timeout') || msg.includes('overloaded') || msg.includes('503');
      if (isRetryable && emptyRetry < MAX_EMPTY_RETRIES) {
        const backoff = (emptyRetry + 1) * 2000;
        console.log(`[gemini] Empty/timeout response, retry ${emptyRetry + 1}/${MAX_EMPTY_RETRIES} after ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('AI returned empty response');
}

// ---------------------------------------------------------------------------
// Web Search — uses Gemini with Google Search grounding
// ---------------------------------------------------------------------------

interface SearchPriceResult {
  competitors: {
    source: string;
    url: string;
    title: string;
    price: number;
    isKnownRetailer: boolean;
  }[];
  searchSummary: string;
}

/**
 * Extract prices from narrative text when JSON parsing fails.
 */
function extractPricesFromNarrative(text: string, productTitle: string): SearchPriceResult {
  const competitors: SearchPriceResult['competitors'] = [];
  const seenPrices = new Set<number>();

  const priceMatches = text.matchAll(/\$\s*([\d,]+\.?\d{0,2})/g);
  for (const match of priceMatches) {
    const price = parseFloat(match[1].replace(/,/g, ''));
    if (price >= 1 && price <= 2000 && !seenPrices.has(price)) {
      seenPrices.add(price);
      const start = Math.max(0, (match.index || 0) - 200);
      const context = text.substring(start, (match.index || 0) + 50);
      let source = 'web-search-extract';
      for (const shop of RETAIL_SMOKE_SHOPS) {
        if (context.toLowerCase().includes(shop)) { source = shop; break; }
      }
      const domainMatch = context.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:com|co|net|org))/i);
      if (domainMatch && source === 'web-search-extract') source = domainMatch[1];

      competitors.push({
        source,
        url: `https://${source}`,
        title: productTitle,
        price,
        isKnownRetailer: RETAIL_SMOKE_SHOPS.some(shop => source.includes(shop)),
      });
    }
  }

  return { competitors, searchSummary: `Extracted ${competitors.length} prices from narrative` };
}

/**
 * Search for competitor prices using Gemini with Google Search grounding.
 * Uses the googleSearch tool for real-time web results.
 */
export async function searchCompetitorsGemini(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity,
): Promise<CompetitorSearchResult> {
  const key = getGeminiKey();
  const productName = identity.identifiedAs || product.title;
  const brand = product.vendor || identity.brand || '';

  const searchPrompt = `Search for retail prices of this smoke shop product and return competitor pricing data.

PRODUCT: ${product.title}
IDENTIFIED AS: ${productName}
BRAND/VENDOR: ${brand || 'Unknown'}
TYPE: ${identity.productType || product.productType || 'Unknown'}
KEY FEATURES: ${(identity.keyFeatures || []).join(', ')}

INSTRUCTIONS:
1. Search for this specific product (or very similar products) at online smoke shops and retail stores
2. Focus on finding actual retail sale prices (NOT wholesale, NOT bulk pricing)
3. Prioritize known smoke shop retailers like: smokea.com, grasscity.com, dankgeek.com, everythingfor420.com, brotherswithglass.com, smokecartel.com
4. Exclude wholesale sites (alibaba, dhgate, etc.)
5. Include the URL, store name, product title, and price for each result

Return JSON (no markdown, just raw JSON):
{
  "competitors": [
    {
      "source": "domain.com",
      "url": "full URL",
      "title": "product listing title",
      "price": 12.99,
      "isKnownRetailer": true
    }
  ],
  "searchSummary": "brief summary of what was found"
}

Return at least 2-5 competitor prices if available. Only include prices between $1 and $2000.`;

  try {
    const result = await geminiRateLimiter.execute(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEARCH_MODEL}:generateContent?key=${key}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: {
            maxOutputTokens: 4000,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        throw new Error(err.error?.message || `Gemini search error: ${res.status}`);
      }

      const data = await res.json();

      let textContent = '';
      if (data.candidates?.[0]?.content?.parts) {
        for (const part of data.candidates[0].content.parts) {
          if (part.text) {
            textContent += part.text;
          }
        }
      }

      if (!textContent) {
        throw new Error('No text response from Gemini web search');
      }

      return textContent;
    }, 3);

    let parsed: SearchPriceResult;
    try {
      parsed = parseAIJson<SearchPriceResult>(result);
    } catch {
      parsed = extractPricesFromNarrative(result, product.title);
    }

    const competitors: CompetitorPrice[] = (parsed.competitors || [])
      .filter(c => c.price >= 1 && c.price <= 2000 && c.url && c.source)
      .map(c => {
        const domain = c.source.replace(/^www\./, '');
        const isKnown = c.isKnownRetailer ||
          RETAIL_SMOKE_SHOPS.some(shop => domain.includes(shop));
        return {
          source: domain,
          url: c.url,
          title: c.title || product.title,
          price: c.price,
          extractionMethod: 'gemini-web-search',
          isKnownRetailer: isKnown,
          inStock: true,
        };
      });

    const seenPrices = new Set<number>();
    const dedupedCompetitors = competitors.filter(c => {
      if (seenPrices.has(c.price)) return false;
      seenPrices.add(c.price);
      return true;
    });

    return {
      competitors: dedupedCompetitors,
      rawResults: [],
      excluded: [],
      queries: [`gemini-web-search: ${product.title}`],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error(`Gemini web search failed for "${product.title}": ${msg}`);
    return { competitors: [], rawResults: [], excluded: [], queries: [`gemini-web-search-failed: ${product.title}`] };
  }
}

/**
 * Search for competitor prices on Amazon ONLY using Gemini with Google Search grounding.
 */
export async function searchCompetitorsGeminiAmazon(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity,
): Promise<CompetitorSearchResult> {
  const key = getGeminiKey();
  const productName = identity.identifiedAs || product.title;
  const brand = product.vendor || identity.brand || '';

  const searchPrompt = `Search Amazon.com for this product and return pricing data.

PRODUCT: ${product.title}
IDENTIFIED AS: ${productName}
BRAND/VENDOR: ${brand || 'Unknown'}
TYPE: ${identity.productType || product.productType || 'Unknown'}
KEY FEATURES: ${(identity.keyFeatures || []).join(', ')}

INSTRUCTIONS:
1. Search ONLY on amazon.com for this product or very similar products
2. Use search queries like: site:amazon.com ${productName} ${brand}
3. Find actual Amazon retail/sale prices (NOT third-party wholesale)
4. Include the Amazon URL, listing title, and price for each result
5. If no exact match, include similar products in the same category on Amazon

Return JSON (no markdown, just raw JSON):
{
  "competitors": [
    {
      "source": "amazon.com",
      "url": "full Amazon URL",
      "title": "Amazon listing title",
      "price": 12.99,
      "isKnownRetailer": true
    }
  ],
  "searchSummary": "brief summary of what was found on Amazon"
}

Return up to 5 Amazon listings if available. Only include prices between $1 and $2000.`;

  try {
    const result = await geminiRateLimiter.execute(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEARCH_MODEL}:generateContent?key=${key}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: {
            maxOutputTokens: 4000,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        throw new Error(err.error?.message || `Gemini search error: ${res.status}`);
      }

      const data = await res.json();

      let textContent = '';
      if (data.candidates?.[0]?.content?.parts) {
        for (const part of data.candidates[0].content.parts) {
          if (part.text) {
            textContent += part.text;
          }
        }
      }

      if (!textContent) {
        throw new Error('No text response from Gemini Amazon search');
      }

      return textContent;
    }, 3);

    let parsed: SearchPriceResult;
    try {
      parsed = parseAIJson<SearchPriceResult>(result);
    } catch {
      parsed = extractPricesFromNarrative(result, product.title);
    }

    const competitors: CompetitorPrice[] = (parsed.competitors || [])
      .filter(c => c.price >= 1 && c.price <= 2000)
      .map(c => ({
        source: 'amazon.com',
        url: c.url && c.url.includes('amazon') ? c.url : `https://amazon.com/s?k=${encodeURIComponent(product.title)}`,
        title: c.title || product.title,
        price: c.price,
        extractionMethod: 'gemini-amazon-search',
        isKnownRetailer: true,
        inStock: true,
      }));

    const seenPrices = new Set<number>();
    const dedupedCompetitors = competitors.filter(c => {
      if (seenPrices.has(c.price)) return false;
      seenPrices.add(c.price);
      return true;
    });

    return {
      competitors: dedupedCompetitors,
      rawResults: [],
      excluded: [],
      queries: [`gemini-amazon-search: ${product.title}`],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error(`Gemini Amazon search failed for "${product.title}": ${msg}`);
    return { competitors: [], rawResults: [], excluded: [], queries: [`gemini-amazon-search-failed: ${product.title}`] };
  }
}
