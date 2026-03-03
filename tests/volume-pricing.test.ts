import { describe, it, expect } from 'vitest';
import {
  parseQuantityFromTitle,
  extractFinishKey,
  detectQuantityVariantGroups,
  calculateRawVolumePrice,
  applyRounding,
  calculateVolumePrices,
  DEFAULT_CONFIG,
} from '../src/lib/volume-pricing';

// ============================================================================
// parseQuantityFromTitle
// ============================================================================

describe('parseQuantityFromTitle', () => {
  it('detects "Qty: N" patterns', () => {
    expect(parseQuantityFromTitle('Qty: 90')).toBe(90);
    expect(parseQuantityFromTitle('Case Qty: 180')).toBe(180);
  });

  it('detects "N Count" / "N ct" patterns', () => {
    expect(parseQuantityFromTitle('90 Count')).toBe(90);
    expect(parseQuantityFromTitle('90ct')).toBe(90);
    expect(parseQuantityFromTitle('180 Ct')).toBe(180);
  });

  it('detects "N Pack" / "N Pk" patterns', () => {
    expect(parseQuantityFromTitle('90 Pack')).toBe(90);
    expect(parseQuantityFromTitle('50pk')).toBe(50);
  });

  it('detects "Case of N" patterns', () => {
    expect(parseQuantityFromTitle('Case of 90')).toBe(90);
    expect(parseQuantityFromTitle('Box of 180')).toBe(180);
  });

  it('detects multi-option titles like "Black / 90 Count"', () => {
    expect(parseQuantityFromTitle('Black / 90 Count')).toBe(90);
    expect(parseQuantityFromTitle('Clear - 180 Pack')).toBe(180);
  });

  it('detects standalone numbers >= 2', () => {
    expect(parseQuantityFromTitle('90')).toBe(90);
    expect(parseQuantityFromTitle('2')).toBe(2);
  });

  it('returns null for non-quantity titles', () => {
    expect(parseQuantityFromTitle('Black')).toBeNull();
    expect(parseQuantityFromTitle('Small / Red')).toBeNull();
    expect(parseQuantityFromTitle('')).toBeNull();
    expect(parseQuantityFromTitle(null)).toBeNull();
  });

  it('ignores standalone "1"', () => {
    expect(parseQuantityFromTitle('1')).toBeNull();
  });
});

// ============================================================================
// extractFinishKey
// ============================================================================

describe('extractFinishKey', () => {
  it('extracts finish from "Black / 90 Count"', () => {
    expect(extractFinishKey('Black / 90 Count', 90)).toBe('Black');
  });

  it('returns null when title is only quantity', () => {
    expect(extractFinishKey('90 Count', 90)).toBeNull();
    expect(extractFinishKey('90', 90)).toBeNull();
  });

  it('handles multi-part finishes', () => {
    expect(extractFinishKey('Black / Frosted / 180 Pack', 180)).toBe('Black / Frosted');
  });
});

// ============================================================================
// detectQuantityVariantGroups
// ============================================================================

describe('detectQuantityVariantGroups', () => {
  const makeVariant = (id: string, title: string) => ({
    id, title, price: '10.00', sku: '', inventory_quantity: 0,
  });

  it('groups quantity variants correctly', () => {
    const variants = [
      makeVariant('v1', '90 Count'),
      makeVariant('v2', '180 Count'),
      makeVariant('v3', '360 Count'),
    ];
    const groups = detectQuantityVariantGroups(variants as any);
    expect(groups).not.toBeNull();
    expect(groups!.length).toBe(1);
    expect(groups![0].baseVariant.quantity).toBe(90);
    expect(groups![0].variants.length).toBe(3);
  });

  it('groups by finish key', () => {
    const variants = [
      makeVariant('v1', 'Black / 90 Count'),
      makeVariant('v2', 'Black / 180 Count'),
      makeVariant('v3', 'Clear / 90 Count'),
      makeVariant('v4', 'Clear / 180 Count'),
    ];
    const groups = detectQuantityVariantGroups(variants as any);
    expect(groups).not.toBeNull();
    expect(groups!.length).toBe(2);
  });

  it('returns null for non-quantity variants', () => {
    const variants = [
      makeVariant('v1', 'Small'),
      makeVariant('v2', 'Large'),
    ];
    expect(detectQuantityVariantGroups(variants as any)).toBeNull();
  });

  it('returns null for single variant', () => {
    const variants = [makeVariant('v1', '90 Count')];
    expect(detectQuantityVariantGroups(variants as any)).toBeNull();
  });
});

// ============================================================================
// calculateRawVolumePrice
// ============================================================================

describe('calculateRawVolumePrice', () => {
  it('returns basePrice when qty equals baseQty', () => {
    expect(calculateRawVolumePrice(20, 90, 90, 0.92)).toBe(20);
  });

  it('calculates power-law price for 2x quantity', () => {
    // 20 * (180/90)^0.92 = 20 * 2^0.92 ≈ 37.86
    const result = calculateRawVolumePrice(20, 90, 180, 0.92);
    expect(result).toBeCloseTo(37.86, 1);
  });

  it('total price increases with quantity', () => {
    const p90 = calculateRawVolumePrice(20, 90, 90, 0.92);
    const p180 = calculateRawVolumePrice(20, 90, 180, 0.92);
    const p360 = calculateRawVolumePrice(20, 90, 360, 0.92);
    expect(p180).toBeGreaterThan(p90);
    expect(p360).toBeGreaterThan(p180);
  });

  it('per-unit price decreases with quantity', () => {
    const perUnit90 = calculateRawVolumePrice(20, 90, 90, 0.92) / 90;
    const perUnit180 = calculateRawVolumePrice(20, 90, 180, 0.92) / 180;
    const perUnit360 = calculateRawVolumePrice(20, 90, 360, 0.92) / 360;
    expect(perUnit180).toBeLessThan(perUnit90);
    expect(perUnit360).toBeLessThan(perUnit180);
  });

  it('lower exponent = steeper discount', () => {
    const premium = calculateRawVolumePrice(20, 90, 360, 0.95) / 360;
    const aggressive = calculateRawVolumePrice(20, 90, 360, 0.85) / 360;
    expect(aggressive).toBeLessThan(premium);
  });
});

// ============================================================================
// applyRounding
// ============================================================================

describe('applyRounding', () => {
  it('rounds to nearest dollar', () => {
    expect(applyRounding(37.86, 'nearest_dollar')).toBe(38);
    expect(applyRounding(37.49, 'nearest_dollar')).toBe(37);
  });

  it('rounds to nearest 50 cents', () => {
    expect(applyRounding(37.86, 'nearest_50_cents')).toBe(38.0);
    expect(applyRounding(37.30, 'nearest_50_cents')).toBe(37.5);
  });

  it('rounds to two decimals', () => {
    expect(applyRounding(37.8635, 'two_decimals')).toBe(37.86);
  });

  it('applies charm pricing', () => {
    expect(applyRounding(37.86, 'charm_pricing')).toBe(37.99);
    expect(applyRounding(38.01, 'charm_pricing')).toBe(38.99);
  });
});

// ============================================================================
// calculateVolumePrices (integration)
// ============================================================================

describe('calculateVolumePrices', () => {
  const tiers = [
    { variantId: 'v1', quantity: 90 },
    { variantId: 'v2', quantity: 180 },
    { variantId: 'v3', quantity: 360 },
  ];

  it('produces correct number of results', () => {
    const output = calculateVolumePrices(20, 90, tiers);
    expect(output.results.length).toBe(3);
  });

  it('marks the base variant correctly', () => {
    const output = calculateVolumePrices(20, 90, tiers);
    const base = output.results.find(r => r.isBase);
    expect(base).toBeDefined();
    expect(base!.quantity).toBe(90);
    expect(base!.calculatedPrice).toBe(20);
  });

  it('total prices are monotonically increasing', () => {
    const output = calculateVolumePrices(20, 90, tiers);
    for (let i = 1; i < output.results.length; i++) {
      expect(output.results[i].calculatedPrice).toBeGreaterThan(output.results[i - 1].calculatedPrice);
    }
  });

  it('per-unit prices are monotonically decreasing', () => {
    const output = calculateVolumePrices(20, 90, tiers);
    for (let i = 1; i < output.results.length; i++) {
      expect(output.results[i].perUnit).toBeLessThan(output.results[i - 1].perUnit);
    }
  });

  it('warns when exponent is out of range', () => {
    const output = calculateVolumePrices(20, 90, tiers, { exponent: 0.50 });
    expect(output.warnings.length).toBeGreaterThan(0);
    expect(output.warnings[0]).toContain('outside recommended range');
  });

  it('uses default config values', () => {
    const output = calculateVolumePrices(20, 90, tiers);
    expect(output.exponent).toBe(DEFAULT_CONFIG.exponent);
    expect(output.roundingMethod).toBe(DEFAULT_CONFIG.roundingMethod);
  });

  it('respects custom rounding method', () => {
    const output = calculateVolumePrices(20, 90, tiers, { roundingMethod: 'charm_pricing' });
    // All non-base prices should end in .99
    for (const r of output.results) {
      if (!r.isBase) {
        expect(r.calculatedPrice % 1).toBeCloseTo(0.99, 1);
      }
    }
  });
});
