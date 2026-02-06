// OpenAI web search-based competitor price research
// Uses the OpenAI Responses API with web_search tool to find competitor prices
// Replaces Brave Search for batch processing (no separate API key needed, better rate limits)

import { openaiRateLimiter } from './rate-limiter';
import { parseAIJson } from './openai';
import type { ProductIdentity } from '@/types';
import type { CompetitorPrice, CompetitorSearchResult } from './competitors';

// Known retail smoke shop domains — prioritized during search
const RETAIL_SMOKE_SHOPS = [
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

  const searchPrompt = `Search for retail prices of this smoke shop product and return competitor pricing data.

PRODUCT: ${product.title}
IDENTIFIED AS: ${productName}
BRAND/VENDOR: ${brand || 'Unknown'}
TYPE: ${productType || 'Unknown'}
QUALITY TIER: ${tier}
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
          reasoning: { effort: 'low' },
          text: { format: { type: 'json_object' } },
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

    // Parse the JSON response
    const parsed = parseAIJson<OpenAISearchPriceResult>(result);

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
