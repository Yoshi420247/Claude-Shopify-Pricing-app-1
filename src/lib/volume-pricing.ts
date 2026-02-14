// ============================================================================
// Volume Discount Pricing Engine
// ============================================================================
// Given a base price for the smallest quantity variant of any SKU,
// auto-generates prices for all higher-quantity variants using a
// power-law discount curve.
//
// Formula:  variant_price = base_price × (variant_qty / base_qty) ^ exponent
//
// The exponent controls the steepness of the volume discount curve.
// Values < 1.0 create a concave (diminishing-return) discount curve.
// A value of 1.0 would mean linear (no volume discount).
// ============================================================================

import type { Variant } from '@/types';

// ============================================================================
// Types
// ============================================================================

export interface VolumePricingConfig {
  exponent: number;           // Power-law exponent (default 0.92)
  roundingMethod: RoundingMethod;
  maxDiscountPercent: number; // Max per-unit discount cap (default 35%)
}

export type RoundingMethod =
  | 'nearest_dollar'
  | 'nearest_50_cents'
  | 'two_decimals'
  | 'charm_pricing';

export interface QuantityVariantGroup {
  /** Non-quantity portion of variant title (e.g., "Black/Clear") or null */
  finishKey: string | null;
  /** All variants in this group sorted by quantity ascending */
  variants: QuantityVariant[];
  /** The base (lowest quantity) variant */
  baseVariant: QuantityVariant;
}

export interface QuantityVariant {
  variant: Variant;
  quantity: number;
}

export interface VolumePriceResult {
  variantId: string;
  quantity: number;
  calculatedPrice: number;
  rawPrice: number;
  perUnit: number;
  discountFromBasePercent: number;
  isBase: boolean;
}

export interface VolumePricingOutput {
  baseVariantId: string;
  basePrice: number;
  baseQty: number;
  exponent: number;
  roundingMethod: RoundingMethod;
  results: VolumePriceResult[];
  premiumMultiplier: number | null;
  warnings: string[];
}

// ============================================================================
// Exponent Presets
// ============================================================================

export const EXPONENT_PRESETS = {
  premium:     { value: 0.95, description: '~11% max discount at 10x volume' },
  standard:    { value: 0.92, description: '~17% max discount at 10x volume' },
  competitive: { value: 0.90, description: '~21% max discount at 10x volume' },
  aggressive:  { value: 0.85, description: '~29% max discount at 10x volume' },
} as const;

export const DEFAULT_CONFIG: VolumePricingConfig = {
  exponent: 0.92,
  roundingMethod: 'nearest_dollar',
  maxDiscountPercent: 35,
};

// ============================================================================
// Quantity Detection
// ============================================================================

// Patterns that strongly indicate a quantity in variant titles.
// Order matters: more specific patterns first to avoid false positives.
const QUANTITY_PATTERNS: RegExp[] = [
  // "Case Qty: 90", "Qty: 90", "Qty 90"
  /\bqty[:\s]*(\d+)\b/i,
  // "90 Count", "90ct", "90 Ct"
  /\b(\d+)\s*(?:count|ct)\b/i,
  // "90 Pack", "90 Pk", "90pk"
  /\b(\d+)\s*(?:pack|pk)\b/i,
  // "90 Pcs", "90 Pieces", "90 pcs"
  /\b(\d+)\s*(?:pcs|pieces?)\b/i,
  // "Case of 90", "Box of 180"
  /\b(?:case|box|carton|bag)\s+of\s+(\d+)\b/i,
  // "90-count", "180-pack"
  /\b(\d+)[-](?:count|ct|pack|pk|pcs|pieces?)\b/i,
  // "x90", "x180" (often "1x90")
  /\bx(\d+)\b/i,
];

// Pattern for standalone number (only used when ALL sibling variants also have standalone numbers)
const STANDALONE_NUMBER = /^(\d+)$/;

// Separators used in multi-option variant titles: "Black / 90 Count", "Black - 90"
const OPTION_SEPARATORS = /\s*[\/\-|]\s*/;

/**
 * Try to extract a quantity number from a variant title.
 * Returns the quantity number, or null if not detected.
 */
export function parseQuantityFromTitle(title: string | null): number | null {
  if (!title) return null;
  const trimmed = title.trim();
  if (!trimmed) return null;

  // Split by option separators and check each part
  const parts = trimmed.split(OPTION_SEPARATORS);

  for (const part of parts) {
    const clean = part.trim();
    if (!clean) continue;

    // Try explicit quantity patterns
    for (const pattern of QUANTITY_PATTERNS) {
      const match = clean.match(pattern);
      if (match) {
        const qty = parseInt(match[1], 10);
        if (qty > 0) return qty;
      }
    }
  }

  // Check if the entire title (or a part) is just a number
  for (const part of parts) {
    const clean = part.trim();
    if (STANDALONE_NUMBER.test(clean)) {
      const qty = parseInt(clean, 10);
      // Only consider as quantity if it's a reasonable pack size (≥2)
      if (qty >= 2) return qty;
    }
  }

  return null;
}

/**
 * Extract the non-quantity portion of a variant title (the "finish" key).
 * For example: "Black / 90 Count" → "Black"
 *              "90 Count"         → null (no finish differentiator)
 *              "Black/Frosted / 180 Pack" → "Black/Frosted"
 */
export function extractFinishKey(title: string | null, quantity: number): string | null {
  if (!title) return null;
  const trimmed = title.trim();

  // Split by option separators
  const parts = trimmed.split(OPTION_SEPARATORS);

  // Remove parts that contain the quantity
  const nonQtyParts: string[] = [];
  for (const part of parts) {
    const clean = part.trim();
    if (!clean) continue;

    // Check if this part is the quantity portion
    let isQtyPart = false;
    for (const pattern of QUANTITY_PATTERNS) {
      if (pattern.test(clean)) {
        isQtyPart = true;
        break;
      }
    }
    if (STANDALONE_NUMBER.test(clean) && parseInt(clean, 10) === quantity) {
      isQtyPart = true;
    }

    if (!isQtyPart) {
      nonQtyParts.push(clean);
    }
  }

  if (nonQtyParts.length === 0) return null;
  return nonQtyParts.join(' / ').trim() || null;
}

/**
 * Detect and group quantity-based variants for a product.
 * Returns groups of variants that share the same "finish" (non-quantity option)
 * but differ in quantity tier.
 *
 * Returns null if the product's variants are NOT quantity-based.
 *
 * A product is considered to have quantity variants when:
 * - At least 2 variants have detectable quantities in their titles
 * - Those quantities are all different from each other
 */
export function detectQuantityVariantGroups(variants: Variant[]): QuantityVariantGroup[] | null {
  if (!variants || variants.length < 2) return null;

  // Try to parse quantities from all variants
  const parsed: QuantityVariant[] = [];
  for (const v of variants) {
    const qty = parseQuantityFromTitle(v.title);
    if (qty !== null) {
      parsed.push({ variant: v, quantity: qty });
    }
  }

  // Need at least 2 variants with detected quantities to form a group
  if (parsed.length < 2) return null;

  // Group by finish key
  const finishGroups = new Map<string, QuantityVariant[]>();
  for (const pv of parsed) {
    const finishKey = extractFinishKey(pv.variant.title, pv.quantity) || '__default__';
    const group = finishGroups.get(finishKey) || [];
    group.push(pv);
    finishGroups.set(finishKey, group);
  }

  // Build output groups (only include groups with 2+ quantity tiers)
  const result: QuantityVariantGroup[] = [];
  for (const [key, qvs] of finishGroups) {
    // Check all quantities in this finish group are unique
    const quantities = new Set(qvs.map(qv => qv.quantity));
    if (quantities.size < 2) continue; // Need at least 2 different quantities

    // Sort by quantity ascending
    const sorted = [...qvs].sort((a, b) => a.quantity - b.quantity);

    result.push({
      finishKey: key === '__default__' ? null : key,
      variants: sorted,
      baseVariant: sorted[0], // Lowest quantity is the base
    });
  }

  return result.length > 0 ? result : null;
}

// ============================================================================
// Core Volume Pricing Formula
// ============================================================================

/**
 * Calculate the raw price for a quantity variant using the power-law curve.
 *
 * Formula: variant_price = base_price × (variant_qty / base_qty) ^ exponent
 */
export function calculateRawVolumePrice(
  basePrice: number,
  baseQty: number,
  variantQty: number,
  exponent: number,
): number {
  if (variantQty === baseQty) return basePrice;
  return basePrice * Math.pow(variantQty / baseQty, exponent);
}

/**
 * Apply rounding to a price value.
 */
export function applyRounding(value: number, method: RoundingMethod): number {
  switch (method) {
    case 'nearest_dollar':
      return Math.round(value);
    case 'nearest_50_cents':
      return Math.round(value * 2) / 2;
    case 'two_decimals':
      return Math.round(value * 100) / 100;
    case 'charm_pricing':
      return Math.floor(value) + 0.99;
    default:
      return Math.round(value * 100) / 100;
  }
}

/**
 * Calculate volume-discounted prices for all quantity tiers given a base price.
 *
 * This is the main entry point for computing derived prices.
 */
export function calculateVolumePrices(
  basePrice: number,
  baseQty: number,
  tiers: { variantId: string; quantity: number }[],
  config: Partial<VolumePricingConfig> = {},
): VolumePricingOutput {
  const cfg: VolumePricingConfig = { ...DEFAULT_CONFIG, ...config };
  const basePerUnit = basePrice / baseQty;
  const warnings: string[] = [];
  const results: VolumePriceResult[] = [];

  // Validate exponent
  if (cfg.exponent < 0.80 || cfg.exponent > 0.99) {
    warnings.push(
      `Exponent ${cfg.exponent} is outside recommended range [0.80, 0.99]. ` +
      `Below 0.80 creates unsustainably steep discounts. Above 0.99 is effectively no volume discount.`
    );
  }

  // Sort tiers by quantity
  const sortedTiers = [...tiers].sort((a, b) => a.quantity - b.quantity);

  for (const tier of sortedTiers) {
    const isBase = tier.quantity === baseQty;
    const rawPrice = isBase
      ? basePrice
      : calculateRawVolumePrice(basePrice, baseQty, tier.quantity, cfg.exponent);

    const calculatedPrice = applyRounding(rawPrice, cfg.roundingMethod);
    const perUnit = calculatedPrice / tier.quantity;
    const discountPct = (1 - perUnit / basePerUnit) * 100;

    // Guardrail: check discount cap
    if (discountPct > cfg.maxDiscountPercent) {
      warnings.push(
        `Qty ${tier.quantity} discount is ${discountPct.toFixed(1)}%, ` +
        `exceeds ${cfg.maxDiscountPercent}% cap.`
      );
    }

    results.push({
      variantId: tier.variantId,
      quantity: tier.quantity,
      calculatedPrice,
      rawPrice,
      perUnit: Math.round(perUnit * 10000) / 10000, // 4 decimal places
      discountFromBasePercent: Math.round(discountPct * 10) / 10,
      isBase,
    });
  }

  // Validate monotonicity
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const curr = results[i];

    if (curr.calculatedPrice <= prev.calculatedPrice) {
      warnings.push(
        `Total price did NOT increase: qty ${curr.quantity} ($${curr.calculatedPrice}) ` +
        `<= qty ${prev.quantity} ($${prev.calculatedPrice}). Rounding may have caused this.`
      );
    }
    if (curr.perUnit >= prev.perUnit) {
      warnings.push(
        `Per-unit price did NOT decrease: qty ${curr.quantity} ($${curr.perUnit}/unit) ` +
        `>= qty ${prev.quantity} ($${prev.perUnit}/unit).`
      );
    }
  }

  return {
    baseVariantId: sortedTiers.find(t => t.quantity === baseQty)?.variantId || sortedTiers[0].variantId,
    basePrice,
    baseQty,
    exponent: cfg.exponent,
    roundingMethod: cfg.roundingMethod,
    results,
    premiumMultiplier: null,
    warnings,
  };
}

/**
 * Calculate premium variant prices using a proportional multiplier.
 *
 * Given a standard finish group's prices and a premium base price,
 * derive all premium tier prices using the multiplier approach.
 */
export function calculatePremiumVolumePrices(
  standardOutput: VolumePricingOutput,
  premiumBasePrice: number,
  premiumTiers: { variantId: string; quantity: number }[],
  config: Partial<VolumePricingConfig> = {},
): VolumePricingOutput {
  const cfg: VolumePricingConfig = { ...DEFAULT_CONFIG, ...config };
  const multiplier = premiumBasePrice / standardOutput.basePrice;
  const premiumBasePerUnit = premiumBasePrice / standardOutput.baseQty;
  const warnings: string[] = [];
  const results: VolumePriceResult[] = [];

  const sortedTiers = [...premiumTiers].sort((a, b) => a.quantity - b.quantity);

  for (const tier of sortedTiers) {
    const isBase = tier.quantity === standardOutput.baseQty;
    let rawPrice: number;

    if (isBase) {
      rawPrice = premiumBasePrice;
    } else {
      // Find the standard price for this quantity tier
      const standardResult = standardOutput.results.find(r => r.quantity === tier.quantity);
      if (standardResult) {
        rawPrice = standardResult.calculatedPrice * multiplier;
      } else {
        // Calculate from scratch if no matching standard tier
        rawPrice = calculateRawVolumePrice(premiumBasePrice, standardOutput.baseQty, tier.quantity, cfg.exponent);
      }
    }

    const calculatedPrice = applyRounding(rawPrice, cfg.roundingMethod);
    const perUnit = calculatedPrice / tier.quantity;
    const discountPct = (1 - perUnit / premiumBasePerUnit) * 100;

    if (discountPct > cfg.maxDiscountPercent) {
      warnings.push(
        `Premium qty ${tier.quantity} discount is ${discountPct.toFixed(1)}%, ` +
        `exceeds ${cfg.maxDiscountPercent}% cap.`
      );
    }

    results.push({
      variantId: tier.variantId,
      quantity: tier.quantity,
      calculatedPrice,
      rawPrice,
      perUnit: Math.round(perUnit * 10000) / 10000,
      discountFromBasePercent: Math.round(discountPct * 10) / 10,
      isBase,
    });
  }

  return {
    baseVariantId: sortedTiers.find(t => t.quantity === standardOutput.baseQty)?.variantId || sortedTiers[0].variantId,
    basePrice: premiumBasePrice,
    baseQty: standardOutput.baseQty,
    exponent: cfg.exponent,
    roundingMethod: cfg.roundingMethod,
    results,
    premiumMultiplier: multiplier,
    warnings,
  };
}

/**
 * Build volume pricing analysis reasoning for a derived (non-base) variant.
 * Returns structured reasoning suitable for saving in the analyses table.
 */
export function buildVolumeAnalysisReasoning(
  result: VolumePriceResult,
  output: VolumePricingOutput,
): string[] {
  const reasoning: string[] = [];

  reasoning.push(
    `VOLUME DISCOUNT FORMULA: Price derived from base variant using power-law curve.`
  );
  reasoning.push(
    `Base price: $${output.basePrice.toFixed(2)} for ${output.baseQty} units ` +
    `($${(output.basePrice / output.baseQty).toFixed(4)}/unit).`
  );
  reasoning.push(
    `Formula: $${output.basePrice.toFixed(2)} × (${result.quantity} / ${output.baseQty})^${output.exponent} ` +
    `= $${result.rawPrice.toFixed(2)} → rounded to $${result.calculatedPrice.toFixed(2)}.`
  );
  reasoning.push(
    `Per-unit price: $${result.perUnit.toFixed(4)} (${result.discountFromBasePercent.toFixed(1)}% volume discount).`
  );
  if (output.premiumMultiplier) {
    reasoning.push(
      `Premium multiplier: ${output.premiumMultiplier.toFixed(4)}x applied (proportional premium strategy).`
    );
  }
  reasoning.push(
    `Exponent: ${output.exponent} (${describeExponent(output.exponent)}). ` +
    `Rounding: ${output.roundingMethod}.`
  );

  return reasoning;
}

function describeExponent(exp: number): string {
  if (exp >= 0.94) return 'premium — shallow discount curve';
  if (exp >= 0.91) return 'standard — industry-norm discount curve';
  if (exp >= 0.88) return 'competitive — moderate discount curve';
  return 'aggressive — steep discount curve';
}
