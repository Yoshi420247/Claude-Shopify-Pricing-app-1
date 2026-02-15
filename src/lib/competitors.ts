// Server-side competitor price research — searches web, fetches pages, extracts prices
// Now with smart caching and rate limiting to handle large batches efficiently

import { braveSearch, type BraveSearchResult } from './brave';
import { braveRateLimiter } from './rate-limiter';
import { searchCache } from './search-cache';
import { getAllCompetitorDomains } from './local-competitor-data';
import type { ProductIdentity } from '@/types';

// Known wholesale/distributor domains to always exclude
const WHOLESALE_DOMAINS = [
  'alibaba.com', 'dhgate.com', 'made-in-china.com', 'globalsources.com',
  'wholesale', 'distributor', 'b2b', 'bulk', 'trade', 'reseller',
  'indiamart.com', '1688.com', 'ec21.com', 'tradekey.com',
  'wholesalecentral.com', 'dollardays.com', 'kole.com',
  'chinabrands.com', 'lightinthebox.com',
];

// Known retail smoke shop domains — includes all curated competitor domains
const RETAIL_SMOKE_SHOPS = [
  'smokea.com', 'dankgeek.com', 'everythingfor420.com', 'grasscity.com',
  'dailyhighclub.com', 'brotherswithglass.com', 'smokecartel.com',
  'headshop.com', 'thickassglass.com', 'gogopipes.com', 'kings-pipe.com',
  'tokeplanet.com', 'shopstaywild.com', 'paborito.com', 'stoners.com',
  'badassglass.com', 'dankstop.com', 'hemper.co', 'ssmokeshop.com',
  'worldofbongs.com', 'bongoutlet.com', 'aqualabtechnologies.com',
  ...getAllCompetitorDomains(),
];

export interface CompetitorPrice {
  source: string;
  url: string;
  title: string;
  price: number;
  extractionMethod: string;
  isKnownRetailer: boolean;
  inStock: boolean;
}

export interface CompetitorSearchResult {
  competitors: CompetitorPrice[];
  rawResults: BraveSearchResult[];
  excluded: { source: string; url: string; reason: string }[];
  queries: string[];
}

// Build search queries based on product identity and broadening level
// IMPORTANT: Keep query count low — Brave free tier is strict (10 req/min).
// With 3 concurrent analyses, total Brave calls = 3 × queries_per_analysis.
// Target: 3-4 queries per level, 2-3 levels = 6-12 queries per analysis max.
function buildQueries(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity,
  level: number
): string[] {
  const brand = product.vendor || identity.brand || '';
  const productType = identity.productType || product.productType || '';
  const productName = identity.identifiedAs || product.title;
  const originTier = identity.originTier || 'import';
  const cleanName = productName.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanBrand = brand.replace(/[^\w\s-]/g, ' ').trim();

  if (level === 0) {
    // Most specific: use AI-generated queries + product name
    const queries = [
      ...(identity.searchQueries || []).slice(0, 2), // AI-generated are best, take top 2
      `${cleanName} price buy`,
      `${cleanBrand} ${productType} price`.trim(),
    ].filter(Boolean);
    // Deduplicate
    return [...new Set(queries)].slice(0, 4);
  }

  if (level === 1) {
    // Broader: product type + shop terms
    const searchType = productType || productName || 'glass accessory';
    return [
      `${searchType} smoke shop price`,
      `${searchType} buy online`,
      originTier === 'heady' ? `heady ${searchType} price` : `${searchType} retail price`,
    ].filter(Boolean);
  }

  // Level 2+: Very broad category queries
  const typeLC = (productType || productName || '').toLowerCase();
  const cat = typeLC.includes('pendant') ? 'glass pendant jewelry'
    : typeLC.includes('tool') ? 'dab tool dabber'
    : typeLC.includes('banger') ? 'quartz banger nail'
    : typeLC.includes('cap') ? 'carb cap'
    : typeLC.includes('rig') ? 'dab rig'
    : typeLC.includes('pipe') ? 'glass pipe smoking'
    : typeLC.includes('bubbler') ? 'glass bubbler'
    : typeLC.includes('grinder') ? 'herb grinder'
    : typeLC.includes('tray') ? 'rolling tray'
    : typeLC.includes('container') ? 'silicone container dab'
    : typeLC.includes('mat') ? 'silicone dab mat'
    : typeLC.includes('nectar') ? 'nectar collector'
    : productType || 'smoke shop glass';

  return [
    `${cat} for sale price`,
    `site:smokea.com ${cat}`,
    `site:grasscity.com ${cat}`,
  ];
}

// Extract price from text snippet
export function extractPriceFromSnippet(text: string): number | null {
  if (!text) return null;

  const patterns = [
    /\$\s*([\d,]+\.\d{2})\b/g,
    /\$\s*([\d,]+\.\d{1})\b/g,
    /\$([\d,]+)(?:\s|$|[^\d.])/g,
    /USD\s*([\d,]+\.?\d*)/gi,
    /Price[:\s]+\$?([\d,]+\.?\d*)/gi,
    /from\s+\$([\d,]+\.?\d*)/gi,
    /only\s+\$([\d,]+\.?\d*)/gi,
    /now\s+\$([\d,]+\.?\d*)/gi,
    /sale\s+\$([\d,]+\.?\d*)/gi,
  ];

  const prices: number[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const priceStr = match[1] || match[0];
      const price = parseFloat(priceStr.replace(/[$,\s]/g, ''));
      if (price >= 3 && price <= 2000) {
        prices.push(price);
      }
    }
  }

  if (prices.length === 0) return null;

  const productPrices = prices.filter(p => p >= 8 && p <= 1000);
  return productPrices.length > 0 ? productPrices[0] : prices[0];
}

// Fetch a competitor page and extract price (server-side, no CORS)
async function extractPriceFromPage(url: string): Promise<{ price: number | null; method: string }> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; PricingBot/1.0)' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return { price: null, method: `HTTP ${res.status}` };

    const html = await res.text();

    // JSON-LD Schema.org
    const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of jsonLdMatches) {
      try {
        const data = JSON.parse(m[1]);
        const price = extractSchemaPrice(data);
        if (price) return { price, method: 'schema.org' };
      } catch { /* skip malformed JSON-LD */ }
    }

    // OG price meta tags
    const ogMatch = html.match(/<meta[^>]*property=["'](?:og|product):price:amount["'][^>]*content=["']([^"']+)["']/i);
    if (ogMatch) {
      const price = parseFloat(ogMatch[1]);
      if (price > 0) return { price, method: 'og:price' };
    }

    // itemprop price
    const itemPropMatch = html.match(/<[^>]*itemprop=["']price["'][^>]*content=["']?([\d.]+)["']?/i);
    if (itemPropMatch) {
      const price = parseFloat(itemPropMatch[1]);
      if (price >= 1 && price <= 10000) return { price, method: 'itemprop' };
    }

    // data-price attribute
    const dataPriceMatch = html.match(/data-price=["']?([\d.]+)["']?/i);
    if (dataPriceMatch) {
      const price = parseFloat(dataPriceMatch[1]);
      if (price >= 1 && price <= 10000) return { price, method: 'data-price' };
    }

    // Fallback: dollar pattern in HTML
    const dollarMatches = html.match(/\$\s*([\d,]+\.\d{2})/g);
    if (dollarMatches) {
      const prices = dollarMatches
        .map(m => parseFloat(m.replace(/[$,\s]/g, '')))
        .filter(p => p >= 1 && p <= 10000)
        .sort((a, b) => a - b);
      if (prices.length > 0) {
        return { price: prices[Math.floor(prices.length / 2)], method: 'dollar pattern' };
      }
    }

    return { price: null, method: 'no pattern found' };
  } catch {
    return { price: null, method: 'fetch failed' };
  }
}

function extractSchemaPrice(data: unknown): number | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const price = extractSchemaPrice(item);
      if (price) return price;
    }
    return null;
  }
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if (obj['@type'] === 'Product' || obj['@type'] === 'IndividualProduct') {
      const offers = obj.offers;
      if (Array.isArray(offers)) {
        for (const o of offers) {
          if (typeof o === 'object' && o !== null && 'price' in o) return parseFloat(String(o.price));
        }
      } else if (typeof offers === 'object' && offers !== null) {
        const o = offers as Record<string, unknown>;
        if (o.price) return parseFloat(String(o.price));
        if (o.lowPrice) return parseFloat(String(o.lowPrice));
      }
    }
    if (obj['@graph']) return extractSchemaPrice(obj['@graph']);
  }
  return null;
}

// Main search function: multi-attempt with progressive broadening
// prioritySearchInstruction is unused for Brave (it's for AI search prompts),
// but we accept it for API compatibility with the pricing engine.
export async function searchCompetitors(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity,
  maxAttempts = 3,
  _prioritySearchInstruction?: string,
): Promise<CompetitorSearchResult> {
  const allCompetitors: CompetitorPrice[] = [];
  const allRawResults: BraveSearchResult[] = [];
  const allExcluded: { source: string; url: string; reason: string }[] = [];
  const allQueries: string[] = [];
  const seenUrls = new Set<string>();
  const seenPrices = new Set<number>();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const queries = buildQueries(product, identity, attempt);
    allQueries.push(...queries);

    for (const query of queries) {
      try {
        // Check cache first
        const cached = searchCache.get(query);
        let results: BraveSearchResult[];

        if (cached) {
          // Use cached results
          results = cached.results.map(r => ({
            url: r.url,
            title: r.title,
            description: r.description || '',
            searchQuery: query,
          }));
        } else {
          // Rate-limited search with automatic retry on 429
          results = await braveRateLimiter.execute(() => braveSearch(query, 12), 5);

          // Cache the results
          searchCache.set(query, results.map(r => ({
            url: r.url,
            title: r.title,
            description: r.description,
          })));
        }

        for (const result of results) {
          if (seenUrls.has(result.url)) continue;
          seenUrls.add(result.url);

          let domain: string;
          try {
            domain = new URL(result.url).hostname.replace('www.', '');
          } catch { continue; }

          // Filter wholesale
          if (WHOLESALE_DOMAINS.some(w => domain.includes(w))) {
            allExcluded.push({ source: domain, url: result.url, reason: 'wholesale domain' });
            continue;
          }

          const snippetText = `${result.title} ${result.description}`;
          const snippetPrice = extractPriceFromSnippet(snippetText);
          const isKnownRetailer = RETAIL_SMOKE_SHOPS.some(shop => domain.includes(shop));

          if (snippetPrice && !seenPrices.has(snippetPrice)) {
            seenPrices.add(snippetPrice);
            allCompetitors.push({
              source: domain,
              url: result.url,
              title: result.title,
              price: snippetPrice,
              extractionMethod: 'search snippet',
              isKnownRetailer,
              inStock: true,
            });
          } else {
            allRawResults.push(result);
          }
        }
      } catch (e) {
        console.error(`Search query failed: "${query}":`, e);
      }

      // If we found prices from this query, skip remaining queries at this level
      // This saves Brave API calls — we can always broaden in the next level
      if (allCompetitors.length >= 2) break;
    }

    // If we have 2+ competitor prices, we have enough — stop broadening
    if (allCompetitors.length >= 2) break;
  }

  // For known retailers without snippet prices, try fetching their pages
  const knownWithoutPrice = allRawResults
    .filter(r => {
      try {
        const d = new URL(r.url).hostname.replace('www.', '');
        return RETAIL_SMOKE_SHOPS.some(shop => d.includes(shop));
      } catch { return false; }
    })
    .slice(0, 3);

  for (const result of knownWithoutPrice) {
    try {
      const { price, method } = await extractPriceFromPage(result.url);
      if (price && price > 0 && !seenPrices.has(price)) {
        const domain = new URL(result.url).hostname.replace('www.', '');
        seenPrices.add(price);
        allCompetitors.push({
          source: domain,
          url: result.url,
          title: result.title,
          price,
          extractionMethod: method,
          isKnownRetailer: true,
          inStock: true,
        });
      }
    } catch { /* skip failures */ }
  }

  return {
    competitors: allCompetitors,
    rawResults: allRawResults,
    excluded: allExcluded,
    queries: allQueries,
  };
}
