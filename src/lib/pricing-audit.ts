// ============================================================================
// Variant Pricing Audit — Issue detection, categorization, and fix generation
// ============================================================================
//
// Detects four classes of issues:
//   1. price_mismatch  — color/style variants within a product have different prices
//   2. cost_mismatch   — Shopify cost doesn't match WooCommerce wholesale price
//   3. volume_curve    — quantity variants don't follow the expected discount curve
//   4. irrational      — AI/search finds price is way off vs competitors
//
// Uses the existing volume-pricing engine for variant categorization.
// ============================================================================

import type { Variant, Product } from '@/types';
import {
  detectQuantityVariantGroups,
  parseQuantityFromTitle,
  extractFinishKey,
  calculateVolumePrices,
  DEFAULT_CONFIG,
  type QuantityVariantGroup,
} from './volume-pricing';
import type { WCProduct } from './woocommerce';
import { findWCMatch, type buildWCLookupMaps } from './woocommerce';
import type { ShopifyProductNode } from './shopify';
import { extractId } from './shopify';

// ============================================================================
// Types
// ============================================================================

export type IssueSeverity = 'error' | 'warning' | 'info';
export type IssueType = 'price_mismatch' | 'cost_mismatch' | 'volume_curve' | 'irrational';

export interface AuditIssue {
  type: IssueType;
  severity: IssueSeverity;
  productId: string;
  productTitle: string;
  details: string;
  affectedVariants: AffectedVariant[];
  suggestedFixes: SuggestedFix[];
}

export interface AffectedVariant {
  variantId: string;
  variantTitle: string;
  currentPrice: number;
  currentCost: number | null;
  sku: string | null;
}

export interface SuggestedFix {
  variantId: string;
  variantTitle: string;
  field: 'price' | 'cost';
  currentValue: number;
  suggestedValue: number;
  reason: string;
}

export interface ProductAuditResult {
  productId: string;
  productTitle: string;
  vendor: string | null;
  variantType: 'color_style' | 'quantity' | 'single' | 'mixed';
  variantCount: number;
  quantityGroups: QuantityVariantGroup[] | null;
  wcMatch: WCProduct | null;
  issues: AuditIssue[];
  variants: AuditVariantInfo[];
}

export interface AuditVariantInfo {
  id: string;
  title: string;
  sku: string | null;
  price: number;
  cost: number | null;
  wcWholesalePrice: number | null;
}

export interface AuditSummary {
  timestamp: string;
  totalProducts: number;
  totalVariants: number;
  productsWithIssues: number;
  issueBreakdown: {
    price_mismatch: number;
    cost_mismatch: number;
    volume_curve: number;
    irrational: number;
  };
  variantTypeBreakdown: {
    color_style: number;
    quantity: number;
    single: number;
    mixed: number;
  };
  wcMatchRate: { matched: number; unmatched: number };
  totalFixes: number;
  products: ProductAuditResult[];
}

// ============================================================================
// Convert Shopify GraphQL nodes to internal Variant type
// ============================================================================

export function shopifyNodeToProduct(node: ShopifyProductNode): Product {
  const productId = extractId(node.id);
  return {
    id: productId,
    title: node.title,
    description: node.description,
    description_html: node.descriptionHtml,
    vendor: node.vendor,
    product_type: node.productType,
    handle: node.handle,
    tags: node.tags?.join(', ') || null,
    status: node.status,
    image_url: node.featuredImage?.url || null,
    shopify_gid: node.id,
    synced_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    variants: node.variants.edges.map(e => shopifyVariantNodeToVariant(e.node, productId)),
  };
}

function shopifyVariantNodeToVariant(
  node: ShopifyProductNode['variants']['edges'][0]['node'],
  productId: string,
): Variant {
  return {
    id: extractId(node.id),
    product_id: productId,
    title: node.title,
    sku: node.sku,
    price: parseFloat(node.price),
    compare_at_price: node.compareAtPrice ? parseFloat(node.compareAtPrice) : null,
    cost: node.inventoryItem?.unitCost?.amount
      ? parseFloat(node.inventoryItem.unitCost.amount)
      : null,
    inventory_item_id: node.inventoryItem ? extractId(node.inventoryItem.id) : null,
    shopify_gid: node.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Core Audit Logic
// ============================================================================

/**
 * Audit a single product for pricing issues.
 */
export function auditProduct(
  product: Product,
  wcLookup: ReturnType<typeof buildWCLookupMaps> | null,
): ProductAuditResult {
  const variants = product.variants || [];
  const issues: AuditIssue[] = [];

  // 1. Categorize variants
  const quantityGroups = variants.length >= 2
    ? detectQuantityVariantGroups(variants)
    : null;

  let variantType: ProductAuditResult['variantType'];
  if (variants.length <= 1) {
    variantType = 'single';
  } else if (quantityGroups) {
    // Check if ALL variants are in quantity groups, or some are left over
    const qtyVariantIds = new Set(
      quantityGroups.flatMap(g => g.variants.map(qv => qv.variant.id))
    );
    const nonQtyVariants = variants.filter(v => !qtyVariantIds.has(v.id));
    variantType = nonQtyVariants.length > 0 ? 'mixed' : 'quantity';
  } else {
    variantType = 'color_style';
  }

  // 2. Find WC match
  const firstVariantSku = variants[0]?.sku || null;
  const wcMatch = wcLookup
    ? findWCMatch(firstVariantSku, product.title, wcLookup)
    : null;

  // 3. Detect price mismatches for color/style variants
  if (variantType === 'color_style' || variantType === 'mixed') {
    const colorVariants = variantType === 'mixed'
      ? variants.filter(v => {
          const qty = parseQuantityFromTitle(v.title);
          return qty === null;
        })
      : variants;

    if (colorVariants.length >= 2) {
      const priceMismatchIssues = detectPriceMismatch(product, colorVariants);
      issues.push(...priceMismatchIssues);
    }
  }

  // 4. Detect volume curve violations for quantity variants
  if (quantityGroups) {
    const volumeIssues = detectVolumeCurveViolations(product, quantityGroups);
    issues.push(...volumeIssues);
  }

  // 5. Detect cost mismatches vs WooCommerce
  if (wcMatch && wcLookup) {
    const costIssues = detectCostMismatch(product, variants, wcMatch);
    issues.push(...costIssues);
  }

  // Build variant info
  const wcPrice = wcMatch?.price ? parseFloat(wcMatch.price) : null;
  const auditVariants: AuditVariantInfo[] = variants.map(v => ({
    id: v.id,
    title: v.title || 'Default',
    sku: v.sku,
    price: v.price,
    cost: v.cost,
    wcWholesalePrice: wcPrice,
  }));

  return {
    productId: product.id,
    productTitle: product.title,
    vendor: product.vendor,
    variantType,
    variantCount: variants.length,
    quantityGroups,
    wcMatch,
    issues,
    variants: auditVariants,
  };
}

// ============================================================================
// Issue Detectors
// ============================================================================

/**
 * Detect color/style variants with different prices.
 * All color variants of a product should have the same price.
 */
function detectPriceMismatch(product: Product, colorVariants: Variant[]): AuditIssue[] {
  const prices = colorVariants.map(v => v.price);
  const uniquePrices = new Set(prices);

  if (uniquePrices.size <= 1) return []; // All same price — no issue

  // Find the "correct" price — use the most common price (mode)
  const priceFrequency = new Map<number, number>();
  for (const p of prices) {
    priceFrequency.set(p, (priceFrequency.get(p) || 0) + 1);
  }
  const sortedByFrequency = [...priceFrequency.entries()].sort((a, b) => b[1] - a[1]);
  const correctPrice = sortedByFrequency[0][0];

  const affectedVariants: AffectedVariant[] = [];
  const suggestedFixes: SuggestedFix[] = [];

  for (const v of colorVariants) {
    affectedVariants.push({
      variantId: v.id,
      variantTitle: v.title || 'Default',
      currentPrice: v.price,
      currentCost: v.cost,
      sku: v.sku,
    });

    if (v.price !== correctPrice) {
      suggestedFixes.push({
        variantId: v.id,
        variantTitle: v.title || 'Default',
        field: 'price',
        currentValue: v.price,
        suggestedValue: correctPrice,
        reason: `Color variant "${v.title}" is $${v.price.toFixed(2)} but most variants are $${correctPrice.toFixed(2)}`,
      });
    }
  }

  const priceList = colorVariants.map(v => `${v.title}: $${v.price.toFixed(2)}`).join(', ');

  return [{
    type: 'price_mismatch',
    severity: 'error',
    productId: product.id,
    productTitle: product.title,
    details: `${uniquePrices.size} different prices found across ${colorVariants.length} color/style variants: ${priceList}. Suggested: all set to $${correctPrice.toFixed(2)} (most common).`,
    affectedVariants,
    suggestedFixes,
  }];
}

/**
 * Detect quantity variants that don't follow the expected volume discount curve.
 * Checks that prices increase with quantity but per-unit decreases.
 */
function detectVolumeCurveViolations(
  product: Product,
  quantityGroups: QuantityVariantGroup[],
): AuditIssue[] {
  const issues: AuditIssue[] = [];

  for (const group of quantityGroups) {
    if (group.variants.length < 2) continue;

    const sorted = [...group.variants].sort((a, b) => a.quantity - b.quantity);
    const base = sorted[0];
    const basePrice = base.variant.price;

    // Check monotonicity: total price should increase, per-unit should decrease
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      const prevPerUnit = prev.variant.price / prev.quantity;
      const currPerUnit = curr.variant.price / curr.quantity;

      // Total price should increase with quantity
      if (curr.variant.price <= prev.variant.price) {
        issues.push({
          type: 'volume_curve',
          severity: 'warning',
          productId: product.id,
          productTitle: product.title,
          details: `Volume pricing issue: ${curr.quantity}-count ($${curr.variant.price.toFixed(2)}) is not more expensive than ${prev.quantity}-count ($${prev.variant.price.toFixed(2)}).`,
          affectedVariants: [
            { variantId: curr.variant.id, variantTitle: curr.variant.title || '', currentPrice: curr.variant.price, currentCost: curr.variant.cost, sku: curr.variant.sku },
          ],
          suggestedFixes: [],
        });
      }

      // Per-unit price should decrease with volume
      if (currPerUnit >= prevPerUnit) {
        const expectedOutput = calculateVolumePrices(
          basePrice,
          base.quantity,
          sorted.map(s => ({ variantId: s.variant.id, quantity: s.quantity })),
          DEFAULT_CONFIG,
        );
        const expectedPrice = expectedOutput.results.find(r => r.variantId === curr.variant.id)?.calculatedPrice;

        const fixes: SuggestedFix[] = expectedPrice ? [{
          variantId: curr.variant.id,
          variantTitle: curr.variant.title || '',
          field: 'price',
          currentValue: curr.variant.price,
          suggestedValue: expectedPrice,
          reason: `Per-unit price $${currPerUnit.toFixed(4)} should be less than $${prevPerUnit.toFixed(4)}. Volume formula suggests $${expectedPrice.toFixed(2)}.`,
        }] : [];

        issues.push({
          type: 'volume_curve',
          severity: 'warning',
          productId: product.id,
          productTitle: product.title,
          details: `Per-unit price doesn't decrease: ${curr.quantity}-count is $${currPerUnit.toFixed(4)}/unit but ${prev.quantity}-count is $${prevPerUnit.toFixed(4)}/unit.`,
          affectedVariants: [
            { variantId: curr.variant.id, variantTitle: curr.variant.title || '', currentPrice: curr.variant.price, currentCost: curr.variant.cost, sku: curr.variant.sku },
          ],
          suggestedFixes: fixes,
        });
      }
    }

    // Also check: are the actual prices close to the formula-derived prices?
    const expectedOutput = calculateVolumePrices(
      basePrice,
      base.quantity,
      sorted.map(s => ({ variantId: s.variant.id, quantity: s.quantity })),
      DEFAULT_CONFIG,
    );

    for (const result of expectedOutput.results) {
      if (result.isBase) continue;
      const actual = sorted.find(s => s.variant.id === result.variantId);
      if (!actual) continue;

      const diff = Math.abs(actual.variant.price - result.calculatedPrice);
      const pctDiff = (diff / result.calculatedPrice) * 100;

      // Flag if >15% deviation from formula
      if (pctDiff > 15) {
        issues.push({
          type: 'volume_curve',
          severity: 'info',
          productId: product.id,
          productTitle: product.title,
          details: `${actual.quantity}-count variant is $${actual.variant.price.toFixed(2)} but volume formula suggests $${result.calculatedPrice.toFixed(2)} (${pctDiff.toFixed(0)}% deviation).`,
          affectedVariants: [
            { variantId: actual.variant.id, variantTitle: actual.variant.title || '', currentPrice: actual.variant.price, currentCost: actual.variant.cost, sku: actual.variant.sku },
          ],
          suggestedFixes: [{
            variantId: actual.variant.id,
            variantTitle: actual.variant.title || '',
            field: 'price',
            currentValue: actual.variant.price,
            suggestedValue: result.calculatedPrice,
            reason: `Volume formula (exponent ${DEFAULT_CONFIG.exponent}) suggests $${result.calculatedPrice.toFixed(2)} for ${actual.quantity}-count.`,
          }],
        });
      }
    }
  }

  return issues;
}

/**
 * Detect cost mismatches between Shopify and WooCommerce.
 */
function detectCostMismatch(
  product: Product,
  variants: Variant[],
  wcProduct: WCProduct,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const wcPrice = parseFloat(wcProduct.price || '0');

  if (!wcPrice || wcPrice <= 0) return [];

  for (const v of variants) {
    if (v.cost === null || v.cost === undefined) continue;

    const diff = Math.abs(v.cost - wcPrice);
    const pctDiff = (diff / wcPrice) * 100;

    // Flag if >10% difference or absolute diff >$5
    if (pctDiff > 10 || diff > 5) {
      issues.push({
        type: 'cost_mismatch',
        severity: 'warning',
        productId: product.id,
        productTitle: product.title,
        details: `Variant "${v.title}" Shopify cost $${v.cost.toFixed(2)} vs WC wholesale $${wcPrice.toFixed(2)} (${pctDiff.toFixed(0)}% diff). WC product: "${wcProduct.name}".`,
        affectedVariants: [{
          variantId: v.id,
          variantTitle: v.title || 'Default',
          currentPrice: v.price,
          currentCost: v.cost,
          sku: v.sku,
        }],
        suggestedFixes: [{
          variantId: v.id,
          variantTitle: v.title || 'Default',
          field: 'cost',
          currentValue: v.cost,
          suggestedValue: wcPrice,
          reason: `WooCommerce wholesale price is $${wcPrice.toFixed(2)} but Shopify cost is $${v.cost.toFixed(2)}.`,
        }],
      });
      break; // One cost mismatch per product is enough
    }
  }

  return issues;
}

// ============================================================================
// Summary Builder
// ============================================================================

export function buildAuditSummary(results: ProductAuditResult[]): AuditSummary {
  const totalVariants = results.reduce((sum, r) => sum + r.variantCount, 0);
  const productsWithIssues = results.filter(r => r.issues.length > 0).length;

  const issueBreakdown = { price_mismatch: 0, cost_mismatch: 0, volume_curve: 0, irrational: 0 };
  const variantTypeBreakdown = { color_style: 0, quantity: 0, single: 0, mixed: 0 };
  let totalFixes = 0;
  let wcMatched = 0;
  let wcUnmatched = 0;

  for (const r of results) {
    variantTypeBreakdown[r.variantType]++;
    if (r.wcMatch) wcMatched++;
    else wcUnmatched++;

    for (const issue of r.issues) {
      issueBreakdown[issue.type]++;
      totalFixes += issue.suggestedFixes.length;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalProducts: results.length,
    totalVariants,
    productsWithIssues,
    issueBreakdown,
    variantTypeBreakdown,
    wcMatchRate: { matched: wcMatched, unmatched: wcUnmatched },
    totalFixes,
    products: results.filter(r => r.issues.length > 0), // Only include products with issues
  };
}
