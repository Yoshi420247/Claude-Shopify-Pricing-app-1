// ============================================================================
// Shared Constants — single source of truth for domain lists and thresholds
// ============================================================================
// These were previously duplicated across claude.ts, gemini.ts, competitors.ts,
// and openai-search.ts. Centralizing prevents drift and simplifies updates.

import { getAllCompetitorDomains } from './local-competitor-data';

// ============================================================================
// Domain Lists
// ============================================================================

/** PRIMARY price authority sites — search these FIRST, weight their prices highest */
export const PRIMARY_PRICE_AUTHORITIES = [
  'dragonchewer.com',
  'marijuanapackaging.com',
  'greentechpackaging.com',
] as const;

/** Known wholesale/distributor domains — always exclude from competitor results */
export const WHOLESALE_DOMAINS = [
  'alibaba.com', 'dhgate.com', 'made-in-china.com', 'globalsources.com',
  'wholesale', 'distributor', 'b2b', 'bulk', 'trade', 'reseller',
  'indiamart.com', '1688.com', 'ec21.com', 'tradekey.com',
  'wholesalecentral.com', 'dollardays.com', 'kole.com',
  'chinabrands.com', 'lightinthebox.com',
] as const;

/** Known retail smoke shop domains — includes all curated competitor domains */
export const RETAIL_SMOKE_SHOPS: readonly string[] = [
  ...PRIMARY_PRICE_AUTHORITIES,
  'smokea.com', 'dankgeek.com', 'everythingfor420.com', 'grasscity.com',
  'dailyhighclub.com', 'brotherswithglass.com', 'smokecartel.com',
  'headshop.com', 'thickassglass.com', 'gogopipes.com', 'kings-pipe.com',
  'tokeplanet.com', 'shopstaywild.com', 'paborito.com', 'stoners.com',
  'badassglass.com', 'dankstop.com', 'hemper.co', 'ssmokeshop.com',
  'worldofbongs.com', 'bongoutlet.com', 'aqualabtechnologies.com',
  ...getAllCompetitorDomains(),
];

// ============================================================================
// Price Validation Thresholds
// ============================================================================

/** Minimum valid price for competitor results (filter out noise) */
export const MIN_VALID_PRICE = 1;

/** Maximum valid price for competitor results (filter out bulk/wholesale) */
export const MAX_VALID_PRICE = 2000;

/** Validate a price is within acceptable bounds */
export function isValidPrice(price: number): boolean {
  return (
    typeof price === 'number' &&
    !isNaN(price) &&
    isFinite(price) &&
    price >= MIN_VALID_PRICE &&
    price <= MAX_VALID_PRICE
  );
}

// ============================================================================
// Input Validation Helpers
// ============================================================================

/** Validate a Supabase UUID format */
export function isValidUUID(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Validate a positive number */
export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && isFinite(value) && value > 0;
}

/** Validate a non-negative number */
export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && isFinite(value) && value >= 0;
}

/** Validate a non-empty string */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Check if a domain is a known retail smoke shop */
export function isKnownRetailer(domain: string): boolean {
  const clean = domain.replace(/^www\./, '').toLowerCase();
  return RETAIL_SMOKE_SHOPS.some(shop => clean.includes(shop));
}

/** Check if a domain is a wholesale/distributor */
export function isWholesaleDomain(domain: string): boolean {
  const clean = domain.toLowerCase();
  return WHOLESALE_DOMAINS.some(w => clean.includes(w));
}
