// In-memory search cache with TTL and similarity matching
// Like a smart employee who remembers recent research

import { createServerClient } from './supabase';

interface CachedSearch {
  query: string;
  normalizedQuery: string;
  results: SearchResult[];
  timestamp: number;
  ttl: number; // ms
}

interface SearchResult {
  url: string;
  title: string;
  description: string;
  price?: number;
}

// Normalize query for similarity matching
function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 2)
    .filter(w => !['the', 'and', 'for', 'with', 'from'].includes(w))
    .sort()
    .join(' ');
}

// Calculate similarity between two normalized queries (Jaccard index)
function querySimilarity(a: string, b: string): number {
  const setA = new Set(a.split(' '));
  const setB = new Set(b.split(' '));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

class SearchCache {
  private cache: Map<string, CachedSearch> = new Map();
  private defaultTTL = 30 * 60 * 1000; // 30 minutes
  private maxSize = 500;

  // Try to find cached results for a query (exact or similar)
  get(query: string, similarityThreshold = 0.7): CachedSearch | null {
    const normalized = normalizeQuery(query);
    const now = Date.now();

    // First, try exact match
    for (const [, cached] of this.cache) {
      if (now - cached.timestamp > cached.ttl) {
        continue; // Expired
      }
      if (cached.normalizedQuery === normalized) {
        console.log(`Cache HIT (exact): "${query}"`);
        return cached;
      }
    }

    // Try similar match
    let bestMatch: CachedSearch | null = null;
    let bestSimilarity = 0;

    for (const [, cached] of this.cache) {
      if (now - cached.timestamp > cached.ttl) {
        continue;
      }
      const similarity = querySimilarity(cached.normalizedQuery, normalized);
      if (similarity >= similarityThreshold && similarity > bestSimilarity) {
        bestMatch = cached;
        bestSimilarity = similarity;
      }
    }

    if (bestMatch) {
      console.log(`Cache HIT (${(bestSimilarity * 100).toFixed(0)}% similar): "${query}" ≈ "${bestMatch.query}"`);
      return bestMatch;
    }

    return null;
  }

  // Store search results
  set(query: string, results: SearchResult[], ttl?: number): void {
    // Clean up expired entries if cache is getting full
    if (this.cache.size >= this.maxSize) {
      this.cleanup();
    }

    const cached: CachedSearch = {
      query,
      normalizedQuery: normalizeQuery(query),
      results,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
    };

    this.cache.set(query, cached);
  }

  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, cached] of this.cache) {
      if (now - cached.timestamp > cached.ttl) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.cache.delete(key);
    }

    // If still too full, remove oldest entries
    if (this.cache.size >= this.maxSize) {
      const entries = [...this.cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const removeCount = Math.floor(this.maxSize * 0.2);
      for (let i = 0; i < removeCount; i++) {
        this.cache.delete(entries[i][0]);
      }
    }
  }

  getStats(): { size: number; hitRate: string } {
    return {
      size: this.cache.size,
      hitRate: 'N/A', // Would need to track hits/misses
    };
  }

  clear(): void {
    this.cache.clear();
  }
}

// Singleton instance
export const searchCache = new SearchCache();

// Persistent cache in Supabase for longer-term storage
export async function getPersistedCache(productType: string, vendor: string | null): Promise<SearchResult[] | null> {
  try {
    const db = createServerClient();
    const { data } = await db
      .from('search_cache')
      .select('results, created_at')
      .eq('product_type', productType)
      .eq('vendor', vendor || '')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (data) {
      const age = Date.now() - new Date(data.created_at).getTime();
      if (age < 24 * 60 * 60 * 1000) { // 24 hours
        return data.results as SearchResult[];
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function setPersistedCache(productType: string, vendor: string | null, results: SearchResult[]): Promise<void> {
  try {
    const db = createServerClient();
    await db.from('search_cache').upsert({
      product_type: productType,
      vendor: vendor || '',
      results,
      created_at: new Date().toISOString(),
    }, { onConflict: 'product_type,vendor' });
  } catch (e) {
    console.warn('Failed to persist search cache:', e);
  }
}
