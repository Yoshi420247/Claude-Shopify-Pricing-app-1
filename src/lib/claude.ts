// Claude (Anthropic) API client for chat completions and web search
// Drop-in alternative to OpenAI — same interface, routes to Anthropic API

import { claudeRateLimiter } from './rate-limiter';
import { parseAIJson } from './openai';
import { getAllCompetitorDomains } from './local-competitor-data';
import type { ProductIdentity } from '@/types';
import type { CompetitorPrice, CompetitorSearchResult } from './competitors';

// PRIMARY price authority sites — search these FIRST, weight their prices highest
const PRIMARY_PRICE_AUTHORITIES = [
  'dragonchewer.com', 'marijuanapackaging.com', 'greentechpackaging.com',
];

// Known retail smoke shop domains — includes all curated competitor domains
const RETAIL_SMOKE_SHOPS = [
  'dragonchewer.com', 'marijuanapackaging.com', 'greentechpackaging.com',
  'smokea.com', 'dankgeek.com', 'everythingfor420.com', 'grasscity.com',
  'dailyhighclub.com', 'brotherswithglass.com', 'smokecartel.com',
  'headshop.com', 'thickassglass.com', 'gogopipes.com', 'kings-pipe.com',
  'tokeplanet.com', 'shopstaywild.com', 'paborito.com', 'stoners.com',
  'badassglass.com', 'dankstop.com', 'hemper.co', 'ssmokeshop.com',
  'worldofbongs.com', 'bongoutlet.com', 'aqualabtechnologies.com',
  ...getAllCompetitorDomains(),
];

function getAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  return key;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const SEARCH_MODEL = 'claude-sonnet-4-5-20250929';

// ---------------------------------------------------------------------------
// Chat Completion — same interface as openai.ts chatCompletion()
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

/**
 * Convert OpenAI-style messages to Anthropic format.
 * - System messages → `system` parameter
 * - image_url content parts → Anthropic image format
 */
function convertMessages(messages: ChatMessage[]): {
  system: string;
  anthropicMessages: { role: 'user' | 'assistant'; content: string | AnthropicContent[] }[];
} {
  let system = '';
  const anthropicMessages: { role: 'user' | 'assistant'; content: string | AnthropicContent[] }[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += typeof msg.content === 'string' ? msg.content : '';
      continue;
    }

    if (typeof msg.content === 'string') {
      anthropicMessages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const parts: AnthropicContent[] = msg.content.map(part => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text || '' };
        }
        if (part.type === 'image_url' && part.image_url) {
          return {
            type: 'image' as const,
            source: { type: 'url' as const, url: part.image_url.url },
          };
        }
        return { type: 'text' as const, text: '' };
      }).filter(p => p.type === 'image' || (p.type === 'text' && 'text' in p && p.text));

      anthropicMessages.push({ role: msg.role as 'user' | 'assistant', content: parts });
    }
  }

  return { system, anthropicMessages };
}

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } };

/**
 * Map reasoning effort to Claude extended thinking budget.
 */
function getThinkingConfig(effort: string | undefined): { type: 'enabled'; budget_tokens: number } | undefined {
  switch (effort) {
    case 'high': return { type: 'enabled', budget_tokens: 10000 };
    case 'xhigh': return { type: 'enabled', budget_tokens: 16000 };
    case 'medium': return { type: 'enabled', budget_tokens: 5000 };
    default: return undefined; // 'none', 'low', or undefined — no thinking
  }
}

/**
 * Chat completion using Claude (Anthropic Messages API).
 * Same interface as chatCompletion() from openai.ts.
 */
export async function claudeChatCompletion(options: ChatCompletionOptions): Promise<string> {
  const key = getAnthropicKey();
  const model = options.model || DEFAULT_MODEL;
  const { system, anthropicMessages } = convertMessages(options.messages);
  const thinking = getThinkingConfig(options.reasoningEffort);

  // When using thinking, max_tokens must include thinking budget + response tokens
  const responseTokens = options.maxTokens || 4000;
  const maxTokens = thinking ? thinking.budget_tokens + responseTokens : responseTokens;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
  };

  if (system) {
    body.system = system;
  }

  if (thinking) {
    body.thinking = thinking;
    // Temperature must be 1 when thinking is enabled
  } else if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  // For JSON mode, add a prefill to encourage JSON output (only when not using thinking)
  if (options.jsonMode && !thinking) {
    anthropicMessages.push({ role: 'assistant', content: '{' });
    body.messages = anthropicMessages;
  }

  const MAX_EMPTY_RETRIES = 2;
  let lastError: Error | null = null;

  for (let emptyRetry = 0; emptyRetry <= MAX_EMPTY_RETRIES; emptyRetry++) {
    try {
      const content = await claudeRateLimiter.execute(async () => {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
          throw new Error(err.error?.message || `Anthropic error: ${res.status}`);
        }

        const data = await res.json();

        // Extract text from content blocks (skip thinking blocks)
        let text = '';
        if (data.content && Array.isArray(data.content)) {
          for (const block of data.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
        }

        if (!text) {
          if (data.stop_reason === 'refusal') {
            throw new Error(`AI refused the request`);
          }
          throw new Error('AI returned empty response');
        }

        // If we used JSON prefill, prepend the opening brace
        if (options.jsonMode && !thinking) {
          text = '{' + text;
        }

        return text;
      }, 3);

      return content;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const msg = lastError.message.toLowerCase();
      const isRetryable = msg.includes('empty response') || msg.includes('timeout') || msg.includes('overloaded');
      if (isRetryable && emptyRetry < MAX_EMPTY_RETRIES) {
        const backoff = (emptyRetry + 1) * 2000;
        console.log(`[claude] Empty/timeout response, retry ${emptyRetry + 1}/${MAX_EMPTY_RETRIES} after ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('AI returned empty response');
}

// ---------------------------------------------------------------------------
// Web Search — uses Claude with web_search tool
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
 * Search for competitor prices using Claude web search (general web).
 */
export async function searchCompetitorsClaude(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity,
  prioritySearchInstruction?: string,
): Promise<CompetitorSearchResult> {
  const key = getAnthropicKey();
  const productName = identity.identifiedAs || product.title;
  const brand = product.vendor || identity.brand || '';

  const prioritySites = prioritySearchInstruction || `
1. **SEARCH THESE SITES FIRST** (primary price authorities — their prices carry the most weight):
   - dragonchewer.com — search site:dragonchewer.com for "${productName}"
   - marijuanapackaging.com — search site:marijuanapackaging.com for "${productName}"`;

  const searchPrompt = `Search for retail prices of this smoke shop product and return competitor pricing data.

PRODUCT: ${product.title}
IDENTIFIED AS: ${productName}
BRAND/VENDOR: ${brand || 'Unknown'}
TYPE: ${identity.productType || product.productType || 'Unknown'}
KEY FEATURES: ${(identity.keyFeatures || []).join(', ')}

INSTRUCTIONS:
${prioritySites}
2. Then search other online smoke shops and retail stores for additional data points
3. Focus on finding actual retail sale prices (NOT wholesale, NOT bulk pricing)
4. Also check: smokea.com, grasscity.com, dankgeek.com, everythingfor420.com, brotherswithglass.com, smokecartel.com
5. Exclude wholesale sites (alibaba, dhgate, etc.)
6. Include the URL, store name, product title, and price for each result

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
    const result = await claudeRateLimiter.execute(async () => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: SEARCH_MODEL,
          max_tokens: 4000,
          tools: [{ type: 'web_search_20250305' }],
          messages: [{ role: 'user', content: searchPrompt }],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        throw new Error(err.error?.message || `Anthropic search error: ${res.status}`);
      }

      const data = await res.json();

      // Extract text content from response (skip tool_use and search_result blocks)
      let textContent = '';
      if (data.content && Array.isArray(data.content)) {
        for (const block of data.content) {
          if (block.type === 'text') {
            textContent += block.text;
          }
        }
      }

      if (!textContent) {
        throw new Error('No text response from Claude web search');
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
          extractionMethod: 'claude-web-search',
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
      queries: [`claude-web-search: ${product.title}`],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error(`Claude web search failed for "${product.title}": ${msg}`);
    return { competitors: [], rawResults: [], excluded: [], queries: [`claude-web-search-failed: ${product.title}`] };
  }
}

/**
 * Search for competitor prices on Amazon ONLY using Claude web search.
 */
export async function searchCompetitorsClaudeAmazon(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity,
  prioritySearchInstruction?: string,
): Promise<CompetitorSearchResult> {
  const key = getAnthropicKey();
  const productName = identity.identifiedAs || product.title;
  const brand = product.vendor || identity.brand || '';

  const prioritySites = prioritySearchInstruction || `
1. **SEARCH THESE SITES FIRST** (primary price authorities):
   - dragonchewer.com — search site:dragonchewer.com for "${productName}"
   - marijuanapackaging.com — search site:marijuanapackaging.com for "${productName}"`;

  const searchPrompt = `Search for this product on Amazon AND key competitor sites, and return pricing data.

PRODUCT: ${product.title}
IDENTIFIED AS: ${productName}
BRAND/VENDOR: ${brand || 'Unknown'}
TYPE: ${identity.productType || product.productType || 'Unknown'}
KEY FEATURES: ${(identity.keyFeatures || []).join(', ')}

INSTRUCTIONS:
${prioritySites}
2. Then search amazon.com for this product or very similar products
3. Find actual retail/sale prices (NOT wholesale, NOT bulk pricing)
4. Include the URL, store name, listing title, and price for each result
5. If no exact match, include similar products in the same category

Return JSON (no markdown, just raw JSON):
{
  "competitors": [
    {
      "source": "domain.com",
      "url": "full URL",
      "title": "listing title",
      "price": 12.99,
      "isKnownRetailer": true
    }
  ],
  "searchSummary": "brief summary of what was found"
}

Return up to 8 listings if available. Only include prices between $1 and $2000.`;

  try {
    const result = await claudeRateLimiter.execute(async () => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: SEARCH_MODEL,
          max_tokens: 4000,
          tools: [{ type: 'web_search_20250305' }],
          messages: [{ role: 'user', content: searchPrompt }],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        throw new Error(err.error?.message || `Anthropic search error: ${res.status}`);
      }

      const data = await res.json();

      let textContent = '';
      if (data.content && Array.isArray(data.content)) {
        for (const block of data.content) {
          if (block.type === 'text') {
            textContent += block.text;
          }
        }
      }

      if (!textContent) {
        throw new Error('No text response from Claude Amazon search');
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
        extractionMethod: 'claude-amazon-search',
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
      queries: [`claude-amazon-search: ${product.title}`],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error(`Claude Amazon search failed for "${product.title}": ${msg}`);
    return { competitors: [], rawResults: [], excluded: [], queries: [`claude-amazon-search-failed: ${product.title}`] };
  }
}
