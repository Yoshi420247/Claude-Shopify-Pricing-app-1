// Advanced E-Commerce Pricing Strategies
// Expert-level algorithms for optimal pricing decisions

import type { ProductIdentity, Settings } from '@/types';
import type { CompetitorPrice } from './competitors';

// ============================================================================
// PRICING STRATEGY TYPES
// ============================================================================

export interface PricingContext {
  cost: number;
  currentPrice: number;
  msrp: number | null;
  identity: ProductIdentity;
  competitors: CompetitorPrice[];
  settings: Settings;
}

export interface OptimalPrice {
  price: number;
  strategy: string;
  confidence: 'high' | 'medium' | 'low';
  profitMargin: number;
  profitDollars: number;
  marketPosition: 'value-leader' | 'competitive' | 'premium' | 'luxury';
  psychologicalFactors: string[];
  reasoning: string[];
}

export interface CompetitorIntelligence {
  weightedMedian: number;
  weightedMean: number;
  priceFloor: number;
  priceCeiling: number;
  competitiveRange: { low: number; high: number };
  marketGap: number | null;  // Price gap opportunity
  dominantPricePoint: number | null;
  reliability: 'high' | 'medium' | 'low';
}

// ============================================================================
// COMPETITOR INTELLIGENCE SCORING
// ============================================================================

/**
 * Score and weight competitor prices by relevance and reliability
 * - Known retailers get higher weight
 * - Exact product matches get higher weight
 * - Schema.org extracted prices are more reliable than pattern matching
 */
export function analyzeCompetitorIntelligence(
  competitors: CompetitorPrice[],
  identity: ProductIdentity
): CompetitorIntelligence {
  if (competitors.length === 0) {
    return {
      weightedMedian: 0,
      weightedMean: 0,
      priceFloor: 0,
      priceCeiling: 0,
      competitiveRange: { low: 0, high: 0 },
      marketGap: null,
      dominantPricePoint: null,
      reliability: 'low',
    };
  }

  // Score each competitor
  const scored = competitors.map(c => {
    let weight = 1.0;

    // Known retailer bonus (+50%)
    if (c.isKnownRetailer) weight += 0.5;

    // Extraction method reliability
    if (c.extractionMethod === 'schema.org') weight += 0.4;
    else if (c.extractionMethod === 'og:price') weight += 0.3;
    else if (c.extractionMethod === 'itemprop') weight += 0.25;
    else if (c.extractionMethod === 'data-price') weight += 0.2;
    // snippet extraction is baseline

    // In-stock bonus
    if (c.inStock) weight += 0.1;

    return { ...c, weight, weightedPrice: c.price * weight };
  });

  // Calculate weighted statistics
  const totalWeight = scored.reduce((sum, s) => sum + s.weight, 0);
  const weightedMean = scored.reduce((sum, s) => sum + s.weightedPrice, 0) / totalWeight;

  // Weighted median (sort by price, find median weight point)
  const sorted = [...scored].sort((a, b) => a.price - b.price);
  let cumWeight = 0;
  let weightedMedian = sorted[0].price;
  for (const s of sorted) {
    cumWeight += s.weight;
    if (cumWeight >= totalWeight / 2) {
      weightedMedian = s.price;
      break;
    }
  }

  // Price distribution analysis
  const prices = sorted.map(s => s.price);
  const priceFloor = prices[0];
  const priceCeiling = prices[prices.length - 1];

  // Find the "competitive range" (25th to 75th percentile)
  const q1Index = Math.floor(prices.length * 0.25);
  const q3Index = Math.floor(prices.length * 0.75);
  const competitiveRange = {
    low: prices[q1Index] || priceFloor,
    high: prices[q3Index] || priceCeiling,
  };

  // Find market gaps (price points with no competition)
  let marketGap: number | null = null;
  if (prices.length >= 3) {
    let maxGap = 0;
    let gapMidpoint = 0;
    for (let i = 1; i < prices.length; i++) {
      const gap = prices[i] - prices[i - 1];
      if (gap > maxGap && gap > prices[i - 1] * 0.15) {
        maxGap = gap;
        gapMidpoint = (prices[i] + prices[i - 1]) / 2;
      }
    }
    if (maxGap > 0) marketGap = gapMidpoint;
  }

  // Find dominant price point (cluster analysis)
  const priceClusters = new Map<number, number>();
  for (const p of prices) {
    // Round to nearest $5 for clustering
    const cluster = Math.round(p / 5) * 5;
    priceClusters.set(cluster, (priceClusters.get(cluster) || 0) + 1);
  }
  let dominantPricePoint: number | null = null;
  let maxClusterSize = 0;
  for (const [cluster, count] of priceClusters) {
    if (count > maxClusterSize) {
      maxClusterSize = count;
      dominantPricePoint = cluster;
    }
  }

  // Reliability based on data quality
  const knownRetailerCount = scored.filter(s => s.isKnownRetailer).length;
  const schemaCount = scored.filter(s => s.extractionMethod === 'schema.org').length;
  const reliability: 'high' | 'medium' | 'low' =
    knownRetailerCount >= 3 && schemaCount >= 2 ? 'high' :
    knownRetailerCount >= 1 || schemaCount >= 1 ? 'medium' : 'low';

  return {
    weightedMedian,
    weightedMean,
    priceFloor,
    priceCeiling,
    competitiveRange,
    marketGap,
    dominantPricePoint,
    reliability,
  };
}

// ============================================================================
// PSYCHOLOGICAL PRICING ENGINE
// ============================================================================

interface PsychologicalPricePoint {
  price: number;
  factors: string[];
  score: number;
}

/**
 * Apply psychological pricing principles:
 * - Charm pricing (.99, .95)
 * - Prestige pricing (round numbers for luxury)
 * - Price threshold avoidance ($99 vs $100)
 * - Odd-even pricing strategies
 */
export function findPsychologicalPrice(
  targetPrice: number,
  tier: string,
  style: string
): PsychologicalPricePoint {
  const candidates: PsychologicalPricePoint[] = [];

  // Charm pricing (.99 endings) - most effective under $100
  if (targetPrice < 100) {
    const charm99 = Math.floor(targetPrice) + 0.99;
    candidates.push({
      price: charm99,
      factors: ['charm pricing (.99)', 'perceived bargain'],
      score: targetPrice < 50 ? 0.9 : 0.8,
    });

    const charm95 = Math.floor(targetPrice) + 0.95;
    candidates.push({
      price: charm95,
      factors: ['charm pricing (.95)', 'slightly premium feel'],
      score: 0.75,
    });
  }

  // Prestige pricing (round numbers) - better for heady/luxury
  if (tier === 'heady' || tier === 'domestic') {
    const roundTo5 = Math.round(targetPrice / 5) * 5;
    const roundTo10 = Math.round(targetPrice / 10) * 10;

    candidates.push({
      price: roundTo5,
      factors: ['prestige pricing', 'quality perception'],
      score: tier === 'heady' ? 0.95 : 0.7,
    });

    candidates.push({
      price: roundTo10,
      factors: ['prestige pricing', 'premium positioning', 'easy mental math'],
      score: tier === 'heady' ? 0.9 : 0.65,
    });
  }

  // Price threshold strategy - stay just below major thresholds
  const thresholds = [10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 500];
  for (const threshold of thresholds) {
    if (targetPrice > threshold * 0.9 && targetPrice < threshold * 1.1) {
      // Just below threshold
      candidates.push({
        price: threshold - 0.01,
        factors: [`below $${threshold} threshold`, 'reduced purchase resistance'],
        score: 0.85,
      });

      // Premium position (exactly at or slightly above)
      if (tier === 'heady' || tier === 'domestic') {
        candidates.push({
          price: threshold,
          factors: [`at $${threshold} anchor`, 'quality signal'],
          score: 0.7,
        });
      }
    }
  }

  // Left-digit effect (e.g., $39 vs $40)
  if (targetPrice >= 10) {
    const leftDigitPrice = Math.floor(targetPrice / 10) * 10 - 0.01;
    if (leftDigitPrice > 0 && Math.abs(leftDigitPrice - targetPrice) < targetPrice * 0.05) {
      candidates.push({
        price: leftDigitPrice,
        factors: ['left-digit effect', 'appears significantly cheaper'],
        score: 0.88,
      });
    }
  }

  // Apply style preference
  if (style === 'clean') {
    for (const c of candidates) {
      if (c.price === Math.round(c.price)) {
        c.score += 0.2;
      }
    }
  } else if (style === 'psychological') {
    for (const c of candidates) {
      if (String(c.price).includes('.99') || String(c.price).includes('.95')) {
        c.score += 0.2;
      }
    }
  }

  // Find best candidate closest to target with highest score
  if (candidates.length === 0) {
    return {
      price: targetPrice,
      factors: ['no psychological adjustment'],
      score: 0.5,
    };
  }

  // Score by combination of psychological effectiveness and proximity to target
  for (const c of candidates) {
    const proximityPenalty = Math.abs(c.price - targetPrice) / targetPrice;
    c.score = c.score * (1 - proximityPenalty * 0.5);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// ============================================================================
// PROFIT OPTIMIZATION ENGINE
// ============================================================================

interface ProfitOptimization {
  optimalPrice: number;
  profitMargin: number;
  profitDollars: number;
  priceElasticityAdjustment: number;
  reasoning: string;
}

/**
 * Calculate optimal profit point considering:
 * - Cost basis
 * - Tier-specific markup expectations
 * - Price elasticity estimation
 * - Competitive positioning
 */
export function optimizeForProfit(
  cost: number,
  competitorIntel: CompetitorIntelligence,
  identity: ProductIdentity,
  settings: Settings
): ProfitOptimization {
  const tier = identity.originTier || 'import';

  // Tier-specific optimal markup ranges (based on industry data)
  const markupRanges: Record<string, { min: number; optimal: number; max: number }> = {
    import: { min: 2.0, optimal: 2.8, max: 4.0 },      // 100-300% markup
    domestic: { min: 2.0, optimal: 2.5, max: 3.5 },   // 100-250% markup
    heady: { min: 2.5, optimal: 4.0, max: 10.0 },     // 150-900% markup
  };

  const markup = markupRanges[tier] || markupRanges.import;

  // Start with cost-based optimal
  let optimalPrice = cost * markup.optimal;

  // Adjust based on competitor intelligence
  if (competitorIntel.reliability !== 'low' && competitorIntel.weightedMedian > 0) {
    // If market price is higher than our cost-optimal, we can go higher
    if (competitorIntel.weightedMedian > optimalPrice) {
      // Capture some of the market premium but stay competitive
      optimalPrice = optimalPrice + (competitorIntel.weightedMedian - optimalPrice) * 0.6;
    }
    // If market price is lower, we need to be competitive
    else if (competitorIntel.weightedMedian < optimalPrice) {
      // Can't ignore market, but protect some margin
      const marketDiff = optimalPrice - competitorIntel.weightedMedian;
      optimalPrice = optimalPrice - marketDiff * 0.7;
    }
  }

  // Price elasticity adjustment (smoke shop products are moderately elastic)
  // Higher prices reduce demand, but heady items are less elastic
  const elasticityFactor: Record<string, number> = {
    import: -1.8,    // Very price-sensitive
    domestic: -1.3,  // Moderately price-sensitive
    heady: -0.7,     // Low price sensitivity (collectors/enthusiasts)
  };
  const elasticity = elasticityFactor[tier] || -1.5;

  // Estimate demand impact of pricing above/below market
  let priceElasticityAdjustment = 0;
  if (competitorIntel.weightedMedian > 0) {
    const priceRatio = optimalPrice / competitorIntel.weightedMedian;
    // If we're 10% above market with -1.5 elasticity, expect ~15% demand reduction
    const demandImpact = (priceRatio - 1) * elasticity;
    // Adjust price to optimize profit (price * quantity)
    // Simplified: if demand drops too much, lower price slightly
    if (demandImpact < -0.2) {
      priceElasticityAdjustment = optimalPrice * 0.05; // Reduce by 5%
      optimalPrice -= priceElasticityAdjustment;
    }
  }

  // Apply minimum margin constraint
  const minMarginPrice = cost * (1 + settings.min_margin / 100);
  const minDollarPrice = cost + settings.min_margin_dollars;
  const absoluteFloor = Math.max(minMarginPrice, minDollarPrice);

  if (optimalPrice < absoluteFloor) {
    optimalPrice = absoluteFloor;
  }

  // Calculate final profit metrics
  const profitDollars = optimalPrice - cost;
  const profitMargin = cost > 0 ? (profitDollars / cost) * 100 : 0;

  const reasoning = cost > 0
    ? `${tier} tier with ${markup.optimal}x optimal markup. Cost $${cost.toFixed(2)} × ${(optimalPrice / cost).toFixed(1)}x = $${optimalPrice.toFixed(2)}. Margin: ${profitMargin.toFixed(0)}%.`
    : `Unknown cost. Used market-based pricing with ${tier} tier positioning.`;

  return {
    optimalPrice,
    profitMargin,
    profitDollars,
    priceElasticityAdjustment,
    reasoning,
  };
}

// ============================================================================
// MARKET POSITION STRATEGY
// ============================================================================

type MarketStrategy = 'value-leader' | 'competitive' | 'premium' | 'luxury';

interface PositionStrategy {
  strategy: MarketStrategy;
  targetPosition: number; // 0 = lowest, 1 = highest in market
  priceMultiplier: number;
  reasoning: string;
}

/**
 * Determine optimal market positioning based on product characteristics
 */
export function determineMarketStrategy(
  identity: ProductIdentity,
  competitorIntel: CompetitorIntelligence,
  hasUniqueFeatures: boolean
): PositionStrategy {
  const tier = identity.originTier || 'import';
  const confidence = identity.confidence || 'medium';

  // Heady products should always be premium/luxury
  if (tier === 'heady') {
    return {
      strategy: 'luxury',
      targetPosition: 0.9, // Top 10% of market
      priceMultiplier: 1.15,
      reasoning: 'Heady/artisan products command premium positioning due to uniqueness and craftsmanship.',
    };
  }

  // Domestic products can be premium
  if (tier === 'domestic') {
    // If we have unique features or high confidence, go premium
    if (hasUniqueFeatures || confidence === 'high') {
      return {
        strategy: 'premium',
        targetPosition: 0.75, // Upper quartile
        priceMultiplier: 1.08,
        reasoning: 'USA-made quality product with identifiable value proposition supports premium pricing.',
      };
    }
    return {
      strategy: 'competitive',
      targetPosition: 0.5, // Middle of market
      priceMultiplier: 1.0,
      reasoning: 'Domestic product competing on quality/value balance.',
    };
  }

  // Import products - typically value or competitive
  if (competitorIntel.reliability === 'high' && competitorIntel.priceFloor > 0) {
    // Lots of competition - be value leader or competitive
    if (hasUniqueFeatures) {
      return {
        strategy: 'competitive',
        targetPosition: 0.4,
        priceMultiplier: 0.98,
        reasoning: 'Import product with differentiating features, positioned competitively.',
      };
    }
    return {
      strategy: 'value-leader',
      targetPosition: 0.25, // Lower quartile
      priceMultiplier: 0.92,
      reasoning: 'Import product in competitive market, positioned as value leader.',
    };
  }

  return {
    strategy: 'competitive',
    targetPosition: 0.5,
    priceMultiplier: 1.0,
    reasoning: 'Default competitive positioning.',
  };
}

// ============================================================================
// PRICE ANCHORING STRATEGY
// ============================================================================

interface AnchorStrategy {
  useAnchor: boolean;
  suggestedMsrp: number | null;
  anchorDiscount: number;
  reasoning: string;
}

/**
 * Strategic use of MSRP/compare-at price for value perception
 */
export function determineAnchorStrategy(
  suggestedPrice: number,
  currentMsrp: number | null,
  competitorIntel: CompetitorIntelligence,
  settings: Settings
): AnchorStrategy {
  // If MSRP exists and we respect it, use it
  if (currentMsrp && settings.respect_msrp) {
    const discount = ((currentMsrp - suggestedPrice) / currentMsrp) * 100;
    return {
      useAnchor: discount >= 10, // Only show if meaningful discount
      suggestedMsrp: currentMsrp,
      anchorDiscount: discount,
      reasoning: discount >= 10
        ? `${discount.toFixed(0)}% below MSRP creates compelling value perception.`
        : 'Discount too small to be meaningful anchor.',
    };
  }

  // No MSRP - consider creating one based on competitor ceiling
  if (competitorIntel.priceCeiling > suggestedPrice * 1.15) {
    const suggestedMsrp = Math.round(competitorIntel.priceCeiling / 5) * 5;
    const discount = ((suggestedMsrp - suggestedPrice) / suggestedMsrp) * 100;

    if (discount >= 15 && discount <= 40) {
      return {
        useAnchor: true,
        suggestedMsrp,
        anchorDiscount: discount,
        reasoning: `Suggested MSRP of $${suggestedMsrp} (based on market ceiling) creates ${discount.toFixed(0)}% perceived savings.`,
      };
    }
  }

  return {
    useAnchor: false,
    suggestedMsrp: null,
    anchorDiscount: 0,
    reasoning: 'No effective anchor strategy available.',
  };
}

// ============================================================================
// MASTER PRICING OPTIMIZER
// ============================================================================

/**
 * The master optimizer that combines all strategies to find the truly optimal price
 */
export function calculateOptimalPrice(context: PricingContext): OptimalPrice {
  const { cost, currentPrice, msrp, identity, competitors, settings } = context;
  const tier = identity.originTier || 'import';
  const reasoning: string[] = [];

  // Step 1: Analyze competitor intelligence
  const intel = analyzeCompetitorIntelligence(competitors, identity);
  reasoning.push(`Analyzed ${competitors.length} competitors. Market range: $${intel.priceFloor.toFixed(2)} - $${intel.priceCeiling.toFixed(2)}. Weighted median: $${intel.weightedMedian.toFixed(2)}.`);

  // Step 2: Determine market strategy
  const hasUniqueFeatures = (identity.keyFeatures || []).length >= 3 || identity.confidence === 'high';
  const strategy = determineMarketStrategy(identity, intel, hasUniqueFeatures);
  reasoning.push(`Strategy: ${strategy.strategy}. ${strategy.reasoning}`);

  // Step 3: Calculate profit-optimized base price
  const profitOptimal = optimizeForProfit(cost, intel, identity, settings);
  reasoning.push(`Profit optimization: ${profitOptimal.reasoning}`);

  let targetPrice = profitOptimal.optimalPrice;

  // Step 4: Apply market position strategy
  if (intel.reliability !== 'low' && intel.competitiveRange.low > 0) {
    const marketRange = intel.competitiveRange.high - intel.competitiveRange.low;
    const positionPrice = intel.competitiveRange.low + (marketRange * strategy.targetPosition);

    // Blend profit-optimal with market position
    targetPrice = (targetPrice * 0.6) + (positionPrice * 0.4);
    targetPrice *= strategy.priceMultiplier;
    reasoning.push(`Market position adjustment: targeting ${(strategy.targetPosition * 100).toFixed(0)}th percentile.`);
  }

  // Step 5: Check for market gap opportunity
  if (intel.marketGap && Math.abs(intel.marketGap - targetPrice) < targetPrice * 0.1) {
    targetPrice = intel.marketGap;
    reasoning.push(`Market gap opportunity at $${intel.marketGap.toFixed(2)} - no direct competition.`);
  }

  // Step 6: Apply constraints (SKIP if AI Unrestricted Mode is enabled)
  const isUnrestricted = settings.ai_unrestricted ?? false;

  if (isUnrestricted) {
    reasoning.push(`AI UNRESTRICTED MODE: Skipping all pricing constraints for best expert recommendation.`);
  } else {
    // Min margin
    const absoluteFloor = Math.max(
      cost * (1 + settings.min_margin / 100),
      cost + settings.min_margin_dollars
    );
    if (targetPrice < absoluteFloor) {
      targetPrice = absoluteFloor;
      reasoning.push(`Applied minimum margin floor: $${absoluteFloor.toFixed(2)}.`);
    }

    // MSRP ceiling
    if (msrp && settings.respect_msrp && targetPrice > msrp) {
      targetPrice = msrp;
      reasoning.push(`Capped at MSRP: $${msrp.toFixed(2)}.`);
    }

    // Max above market
    if (intel.priceCeiling > 0) {
      const maxAllowed = intel.priceCeiling * (1 + settings.max_above / 100);
      if (targetPrice > maxAllowed) {
        targetPrice = maxAllowed;
        reasoning.push(`Capped at ${settings.max_above}% above market ceiling: $${maxAllowed.toFixed(2)}.`);
      }
    }

    // Max change from current price
    const maxIncrease = currentPrice * (1 + settings.max_increase / 100);
    const maxDecrease = currentPrice * (1 - settings.max_decrease / 100);
    if (targetPrice > maxIncrease) {
      targetPrice = maxIncrease;
      reasoning.push(`Limited to ${settings.max_increase}% max increase: $${maxIncrease.toFixed(2)}.`);
    } else if (targetPrice < maxDecrease) {
      targetPrice = maxDecrease;
      reasoning.push(`Limited to ${settings.max_decrease}% max decrease: $${maxDecrease.toFixed(2)}.`);
    }
  }

  // Step 7: Apply psychological pricing
  const psychological = findPsychologicalPrice(targetPrice, tier, settings.rounding_style);
  const finalPrice = psychological.price;
  reasoning.push(`Psychological pricing: $${finalPrice.toFixed(2)} (${psychological.factors.join(', ')}).`);

  // Step 8: Final calculations
  const finalProfitDollars = finalPrice - cost;
  const finalProfitMargin = cost > 0 ? (finalProfitDollars / cost) * 100 : 0;

  // Determine confidence
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  if (intel.reliability === 'high' && competitors.length >= 3 && cost > 0) {
    confidence = 'high';
  } else if (intel.reliability === 'low' || competitors.length < 2) {
    confidence = 'low';
  }

  return {
    price: finalPrice,
    strategy: strategy.strategy,
    confidence,
    profitMargin: finalProfitMargin,
    profitDollars: finalProfitDollars,
    marketPosition: strategy.strategy,
    psychologicalFactors: psychological.factors,
    reasoning,
  };
}

// ============================================================================
// INVENTORY VELOCITY ADJUSTMENT
// ============================================================================

interface VelocityAdjustment {
  adjustedPrice: number;
  adjustmentPercent: number;
  reasoning: string;
}

/**
 * Adjust pricing based on inventory velocity (if data available)
 * - Slow sellers get price reductions to move inventory
 * - Fast sellers can support price increases
 */
export function adjustForInventoryVelocity(
  basePrice: number,
  daysInInventory: number | null,
  inventoryQuantity: number | null,
  tier: string
): VelocityAdjustment {
  if (daysInInventory === null || inventoryQuantity === null) {
    return {
      adjustedPrice: basePrice,
      adjustmentPercent: 0,
      reasoning: 'No inventory velocity data available.',
    };
  }

  // Target days in inventory by tier
  const targetDays: Record<string, number> = {
    import: 30,    // Fast-moving commodity items
    domestic: 60,  // Quality items can sit longer
    heady: 120,    // Collectors items can take time
  };

  const target = targetDays[tier] || 45;
  const velocityRatio = daysInInventory / target;

  let adjustmentPercent = 0;
  let reasoning = '';

  if (velocityRatio > 2) {
    // Very slow - significant discount needed
    adjustmentPercent = -10;
    reasoning = `Slow seller (${daysInInventory} days, target ${target}). Applying 10% reduction to increase velocity.`;
  } else if (velocityRatio > 1.5) {
    // Slow - moderate discount
    adjustmentPercent = -5;
    reasoning = `Below-target velocity (${daysInInventory} days). Applying 5% reduction.`;
  } else if (velocityRatio < 0.5 && inventoryQuantity > 5) {
    // Very fast with good inventory - can increase
    adjustmentPercent = 5;
    reasoning = `Fast seller with good inventory. Testing 5% price increase.`;
  } else if (velocityRatio < 0.75 && inventoryQuantity > 3) {
    // Fast - small increase opportunity
    adjustmentPercent = 2;
    reasoning = `Good velocity. Testing 2% price increase.`;
  } else {
    reasoning = `Inventory velocity at target (${daysInInventory} days). No adjustment needed.`;
  }

  const adjustedPrice = basePrice * (1 + adjustmentPercent / 100);

  return {
    adjustedPrice,
    adjustmentPercent,
    reasoning,
  };
}

// ============================================================================
// BUNDLE PRICING LOGIC
// ============================================================================

/**
 * Calculate optimal bundle discount for related products
 */
export function calculateBundlePrice(
  itemPrices: number[],
  tier: string
): { bundlePrice: number; savingsPercent: number; reasoning: string } {
  const totalIndividual = itemPrices.reduce((sum, p) => sum + p, 0);

  // Bundle discounts by tier
  const bundleDiscounts: Record<string, number> = {
    import: 0.15,    // 15% bundle discount (commodity)
    domestic: 0.12,  // 12% bundle discount
    heady: 0.08,     // 8% bundle discount (preserve value perception)
  };

  const discount = bundleDiscounts[tier] || 0.12;
  const bundlePrice = totalIndividual * (1 - discount);
  const savingsPercent = discount * 100;

  return {
    bundlePrice: Math.round(bundlePrice * 100) / 100,
    savingsPercent,
    reasoning: `Bundle pricing: ${savingsPercent}% discount on ${itemPrices.length} items (${tier} tier).`,
  };
}
