// Server-side Brave Search API client with caching

import { searchCache } from './search-cache';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

function getBraveKey(): string {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('BRAVE_API_KEY not configured');
  return key;
}

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  searchQuery: string;
}

export async function braveSearch(query: string, count = 10): Promise<BraveSearchResult[]> {
  // Check cache first to avoid redundant API calls
  const cached = searchCache.get(query);
  if (cached) {
    return cached.results.map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
      searchQuery: query,
    }));
  }

  const key = getBraveKey();
  const retailQuery = `${query} -wholesale -bulk -distributor -alibaba -dhgate -ebay`;

  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(retailQuery)}&count=${count}`;

  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brave Search error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const results: BraveSearchResult[] = (data.web?.results || []).map(
    (r: { title: string; url: string; description: string }) => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
      searchQuery: query,
    })
  );

  // Cache results for 15 minutes to reduce Brave API usage
  searchCache.set(
    query,
    results.map(r => ({ url: r.url, title: r.title, description: r.description })),
    15 * 60 * 1000,
  );

  return results;
}

// Test Brave connection
export async function testBraveConnection() {
  try {
    const key = getBraveKey();
    // Use a lightweight request to test — just check if key is accepted
    const url = `${BRAVE_SEARCH_URL}?q=test&count=1`;
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      return { success: true };
    }
    return { success: false, error: `HTTP ${res.status}` };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (message.includes('not configured')) {
      return { success: false, error: 'BRAVE_API_KEY not set' };
    }
    return { success: false, error: message };
  }
}
