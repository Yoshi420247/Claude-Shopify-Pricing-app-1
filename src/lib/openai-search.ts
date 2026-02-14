// OpenAI web search-based competitor price research
// Uses the OpenAI Responses API with web_search tool to find competitor prices
// Replaces Brave Search for batch processing (no separate API key needed, better rate limits)

import { openaiRateLimiter } from './rate-limiter';
import { parseAIJson } from './openai';
import type { ProductIdentity } from '@/types';
import type { CompetitorPrice, CompetitorSearchResult } from './competitors';

// PRIMARY price authority sites — search these FIRST, weight their prices highest
const PRIMARY_PRICE_AUTHORITIES = [
  'dragonchewer.com', 'marijuanapackaging.com', 'greentechpackaging.com',
];

// Known retail smoke shop domains — prioritized during search
const RETAIL_SMOKE_SHOPS = [
  'dragonchewer.com', 'marijuanapackaging.com', 'greentechpackaging.com',
  'smokea.com', 'dankgeek.com', 'everythingfor420.com', 'grasscity.com',
  'dailyhighclub.com', 'brotherswithglass.com', 'smokecartel.com',
  'headshop.com', 'thickassglass.com', 'gogopipes.com', 'kings-pipe.com',
  'tokeplanet.com', 'shopstaywild.com', 'paborito.com', 'stoners.com',
  'badassglass.com', 'dankstop.com', 'hemper.co', 'ssmokeshop.com',
  'worldofbongs.com', 'bongoutlet.com', 'aqualabtechnologies.com',
];

function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  return key;
}

interface OpenAISearchPriceResult {
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
 * Use OpenAI Responses API with web_search tool to find competitor prices.
 * This replaces Brave Search — uses your existing OpenAI API key with much
 * higher rate limits (no 0.33 req/sec bottleneck).
 */
export async function searchCompetitorsOpenAI(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity,
): Promise<CompetitorSearchResult> {
  const key = getOpenAIKey();
  const productName = identity.identifiedAs || product.title;
  const brand = product.vendor || identity.brand || '';
  const productType = identity.productType || product.productType || '';
  const tier = identity.originTier || 'import';

  const isOilSlick = (brand || '').toLowerCase().includes('oil slick');

  const searchPrompt = `Search for retail prices of this smoke shop product and return competitor pricing data.

PRODUCT: ${product.title}
IDENTIFIED AS: ${productName}
BRAND/VENDOR: ${brand || 'Unknown'}
TYPE: ${productType || 'Unknown'}
QUALITY TIER: ${tier}
KEY FEATURES: ${(identity.keyFeatures || []).join(', ')}

INSTRUCTIONS:
1. **SEARCH THESE SITES FIRST** (primary price authorities — their prices carry the most weight):
   - dragonchewer.com — search site:dragonchewer.com for "${productName}"
   - marijuanapackaging.com — search site:marijuanapackaging.com for "${productName}"
   - greentechpackaging.com — search site:greentechpackaging.com for "${productName}"
   ${isOilSlick ? '⚠️ This is an OIL SLICK product — dragonchewer.com, marijuanapackaging.com, and greentechpackaging.com are the LARGEST direct competitors. Their prices MUST be included if they carry this or similar products.' : ''}
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

Return at least 2-5 competitor prices if available. If no exact matches exist, include similar products in the same category. Only include prices between $1 and $2000.`;

  try {
    const result = await openaiRateLimiter.execute(async () => {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          tools: [{ type: 'web_search' }],
          tool_choice: 'required',
          input: searchPrompt,
          max_output_tokens: 4000,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        throw new Error(err.error?.message || `OpenAI search error: ${res.status}`);
      }

      const data = await res.json();

      // Extract text content from the Responses API output
      let textContent = '';
      if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.type === 'message' && item.content) {
            for (const content of item.content) {
              if (content.type === 'output_text') {
                textContent = content.text;
              }
            }
          }
        }
      }

      if (!textContent) {
        throw new Error('No text response from OpenAI web search');
      }

      return textContent;
    }, 3);

    // Try to parse the JSON response
    let parsed: OpenAISearchPriceResult;
    try {
      parsed = parseAIJson<OpenAISearchPriceResult>(result);
    } catch {
      // Fallback: extract prices from narrative text using regex
      parsed = extractPricesFromNarrative(result, product.title);
    }

    // Convert to CompetitorPrice format
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
          extractionMethod: 'openai-web-search',
          isKnownRetailer: isKnown,
          inStock: true,
        };
      });

    // Deduplicate by price
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
      queries: [`openai-web-search: ${product.title}`],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error(`OpenAI web search failed for "${product.title}": ${msg}`);

    // Return empty results on failure (analysis will use deliberation fallback)
    return {
      competitors: [],
      rawResults: [],
      excluded: [],
      queries: [`openai-web-search-failed: ${product.title}`],
    };
  }
}

/**
 * Use OpenAI Responses API with web_search to find competitor prices on Amazon ONLY.
 * Constrains searches to amazon.com for fast, reliable pricing data without
 * needing to crawl dozens of niche retailers.
 */
export async function searchCompetitorsAmazon(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity,
): Promise<CompetitorSearchResult> {
  const key = getOpenAIKey();
  const productName = identity.identifiedAs || product.title;
  const brand = product.vendor || identity.brand || '';
  const productType = identity.productType || product.productType || '';

  const isOilSlick = (brand || '').toLowerCase().includes('oil slick');

  const searchPrompt = `Search for this product on Amazon AND key competitor sites, and return pricing data.

PRODUCT: ${product.title}
IDENTIFIED AS: ${productName}
BRAND/VENDOR: ${brand || 'Unknown'}
TYPE: ${productType || 'Unknown'}
KEY FEATURES: ${(identity.keyFeatures || []).join(', ')}

INSTRUCTIONS:
1. **SEARCH THESE SITES FIRST** (primary price authorities):
   - dragonchewer.com — search site:dragonchewer.com for "${productName}"
   - marijuanapackaging.com — search site:marijuanapackaging.com for "${productName}"
   - greentechpackaging.com — search site:greentechpackaging.com for "${productName}"
   ${isOilSlick ? '⚠️ This is an OIL SLICK product — dragonchewer.com, marijuanapackaging.com, and greentechpackaging.com are the LARGEST direct competitors. Their prices MUST be included.' : ''}
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
    const result = await openaiRateLimiter.execute(async () => {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          tools: [{ type: 'web_search' }],
          tool_choice: 'required',
          input: searchPrompt,
          max_output_tokens: 4000,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        throw new Error(err.error?.message || `OpenAI search error: ${res.status}`);
      }

      const data = await res.json();

      let textContent = '';
      if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.type === 'message' && item.content) {
            for (const content of item.content) {
              if (content.type === 'output_text') {
                textContent = content.text;
              }
            }
          }
        }
      }

      if (!textContent) {
        throw new Error('No text response from OpenAI Amazon search');
      }

      return textContent;
    }, 3);

    let parsed: OpenAISearchPriceResult;
    try {
      parsed = parseAIJson<OpenAISearchPriceResult>(result);
    } catch {
      parsed = extractPricesFromNarrative(result, product.title);
    }

    // Filter to Amazon results only and convert to CompetitorPrice format
    const competitors: CompetitorPrice[] = (parsed.competitors || [])
      .filter(c => c.price >= 1 && c.price <= 2000)
      .map(c => ({
        source: 'amazon.com',
        url: c.url && c.url.includes('amazon') ? c.url : `https://amazon.com/s?k=${encodeURIComponent(product.title)}`,
        title: c.title || product.title,
        price: c.price,
        extractionMethod: 'openai-amazon-search',
        isKnownRetailer: true,
        inStock: true,
      }));

    // Deduplicate by price
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
      queries: [`amazon-search: ${product.title}`],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error(`OpenAI Amazon search failed for "${product.title}": ${msg}`);

    return {
      competitors: [],
      rawResults: [],
      excluded: [],
      queries: [`amazon-search-failed: ${product.title}`],
    };
  }
}

/**
 * Fallback: extract price data from narrative/non-JSON OpenAI responses.
 * When the model returns text like "priced at $15.00" instead of JSON,
 * we regex-extract prices and build a minimal result.
 */
function extractPricesFromNarrative(text: string, productTitle: string): OpenAISearchPriceResult {
  const competitors: OpenAISearchPriceResult['competitors'] = [];
  const seenPrices = new Set<number>();

  // Extract prices with context (domain mentions near prices)
  const priceMatches = text.matchAll(/\$\s*([\d,]+\.?\d{0,2})/g);
  for (const match of priceMatches) {
    const price = parseFloat(match[1].replace(/,/g, ''));
    if (price >= 1 && price <= 2000 && !seenPrices.has(price)) {
      seenPrices.add(price);
      // Try to find a nearby domain/source name
      const start = Math.max(0, (match.index || 0) - 200);
      const context = text.substring(start, (match.index || 0) + 50);
      let source = 'web-search-extract';
      for (const shop of RETAIL_SMOKE_SHOPS) {
        if (context.toLowerCase().includes(shop)) {
          source = shop;
          break;
        }
      }
      // Also try to find any domain in context
      const domainMatch = context.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:com|co|net|org))/i);
      if (domainMatch && source === 'web-search-extract') {
        source = domainMatch[1];
      }

      competitors.push({
        source,
        url: `https://${source}`,
        title: productTitle,
        price,
        isKnownRetailer: RETAIL_SMOKE_SHOPS.some(shop => source.includes(shop)),
      });
    }
  }

  return {
    competitors,
    searchSummary: `Extracted ${competitors.length} prices from narrative response`,
  };
}
