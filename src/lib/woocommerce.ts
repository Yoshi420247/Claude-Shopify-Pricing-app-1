// WooCommerce REST API client — TypeScript port of Collection repo's woocommerce-client.js
// Fetches wholesale product/cost data from the WooCommerce store for cross-reference auditing

const MIN_REQUEST_INTERVAL = 300; // ms between requests
let lastRequestTime = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface WCProduct {
  id: number;
  name: string;
  sku: string;
  slug: string;
  status: string;
  price: string;
  regular_price: string;
  sale_price: string;
  description: string;
  short_description: string;
  stock_status: string;
  stock_quantity: number | null;
  manage_stock: boolean;
  categories: { name: string }[];
  tags: { name: string }[];
  images: { src: string; alt: string }[];
  attributes: { name: string; options: string[] }[];
  permalink: string;
}

export interface WCProductInfo {
  id: number;
  name: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  categories: string[];
  tags: string[];
}

function getWCConfig() {
  const baseUrl = process.env.WC_STORE_URL;
  const consumerKey = process.env.WC_CONSUMER_KEY;
  const consumerSecret = process.env.WC_CONSUMER_SECRET;

  if (!baseUrl || !consumerKey || !consumerSecret) {
    const missing = [];
    if (!baseUrl) missing.push('WC_STORE_URL');
    if (!consumerKey) missing.push('WC_CONSUMER_KEY');
    if (!consumerSecret) missing.push('WC_CONSUMER_SECRET');
    return null; // WC is optional — return null if not configured
  }

  return { baseUrl, consumerKey, consumerSecret };
}

export function isWCConfigured(): boolean {
  return getWCConfig() !== null;
}

function buildUrl(endpoint: string, params: Record<string, string> = {}): string {
  const config = getWCConfig();
  if (!config) throw new Error('WooCommerce not configured');

  const url = new URL(`/wp-json/wc/v3/${endpoint}`, config.baseUrl);
  url.searchParams.set('consumer_key', config.consumerKey);
  url.searchParams.set('consumer_secret', config.consumerSecret);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function wcRequest(endpoint: string, params: Record<string, string> = {}, retries = 3) {
  const now = Date.now();
  const timeSince = now - lastRequestTime;
  if (timeSince < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - timeSince);
  }
  lastRequestTime = Date.now();

  const url = buildUrl(endpoint, params);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`WooCommerce API ${response.status}: ${text.substring(0, 300)}`);
      }

      const data = await response.json();
      const totalProducts = parseInt(response.headers.get('x-wp-total') || '0', 10);
      const totalPages = parseInt(response.headers.get('x-wp-totalpages') || '1', 10);

      return { data, totalProducts, totalPages };
    } catch (error) {
      if (attempt < retries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`  WC API retry ${attempt}/${retries} after ${waitTime / 1000}s...`);
        await sleep(waitTime);
      } else {
        throw error;
      }
    }
  }

  throw new Error('WC request failed after all retries');
}

/**
 * Fetch all products from WooCommerce with pagination.
 * Returns raw WC product objects with price/cost data.
 */
export async function fetchAllWCProducts(): Promise<WCProduct[]> {
  if (!isWCConfigured()) {
    console.log('⚠ WooCommerce not configured — skipping wholesale cost cross-reference');
    return [];
  }

  const allProducts: WCProduct[] = [];
  let page = 1;
  let totalPages = 1;

  console.log('Fetching all products from WooCommerce...');

  while (page <= totalPages) {
    const result = await wcRequest('products', {
      per_page: '100',
      page: page.toString(),
      orderby: 'id',
      order: 'asc',
    });

    totalPages = result.totalPages;
    const batch = result.data as WCProduct[];

    if (!batch || batch.length === 0) break;

    allProducts.push(...batch);
    if (page % 3 === 0 || page === totalPages) {
      console.log(`  WC page ${page}/${totalPages}: ${allProducts.length} products so far`);
    }
    page++;
  }

  console.log(`✓ WooCommerce: ${allProducts.length} products fetched`);
  return allProducts;
}

/**
 * Build lookup maps for fast matching:
 * - bySku: Map<normalizedSKU, WCProduct>
 * - byName: Map<normalizedName, WCProduct>
 */
export function buildWCLookupMaps(wcProducts: WCProduct[]) {
  const bySku = new Map<string, WCProduct>();
  const byName = new Map<string, WCProduct>();

  for (const p of wcProducts) {
    if (p.sku) {
      bySku.set(p.sku.trim().toLowerCase(), p);
    }
    if (p.name) {
      byName.set(normalizeName(p.name), p);
    }
  }

  return { bySku, byName };
}

/**
 * Try to find a matching WC product for a Shopify variant.
 * Matching priority: exact SKU > fuzzy name match
 */
export function findWCMatch(
  shopifySku: string | null,
  shopifyProductTitle: string,
  wcLookup: ReturnType<typeof buildWCLookupMaps>,
): WCProduct | null {
  // Try exact SKU match first
  if (shopifySku) {
    const normalized = shopifySku.trim().toLowerCase();
    const match = wcLookup.bySku.get(normalized);
    if (match) return match;
  }

  // Try normalized name match
  const normalizedTitle = normalizeName(shopifyProductTitle);
  const nameMatch = wcLookup.byName.get(normalizedTitle);
  if (nameMatch) return nameMatch;

  // Try partial name matching (Shopify title contains WC name or vice versa)
  for (const [wcName, wcProduct] of wcLookup.byName) {
    if (normalizedTitle.includes(wcName) || wcName.includes(normalizedTitle)) {
      return wcProduct;
    }
  }

  return null;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
