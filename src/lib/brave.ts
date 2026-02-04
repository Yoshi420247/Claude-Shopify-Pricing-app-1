// Server-side Brave Search API client

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
  return (data.web?.results || []).map((r: { title: string; url: string; description: string }) => ({
    title: r.title || '',
    url: r.url || '',
    description: r.description || '',
    searchQuery: query,
  }));
}

// Test Brave connection
export async function testBraveConnection() {
  try {
    const results = await braveSearch('test', 1);
    return { success: true, resultCount: results.length };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: message };
  }
}
