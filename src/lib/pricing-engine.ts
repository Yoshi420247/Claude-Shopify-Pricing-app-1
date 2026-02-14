// Core AI pricing analysis pipeline using GPT-5.2 or Claude with reasoning
// Handles: product identification → competitor search → AI pricing → deliberation
// Enhanced with expert-level pricing strategies for optimal results

import { chatCompletion, parseAIJson } from './openai';
import { claudeChatCompletion, searchCompetitorsClaude, searchCompetitorsClaudeAmazon } from './claude';
import { searchCompetitors, type CompetitorSearchResult } from './competitors';
import { searchCompetitorsOpenAI, searchCompetitorsAmazon } from './openai-search';
import { createServerClient } from './supabase';

export type SearchMode = 'brave' | 'openai' | 'amazon' | 'none';
export type Provider = 'openai' | 'claude';

/** Get the appropriate chat completion function for the provider */
function getCompletionFn(provider: Provider) {
  return provider === 'claude' ? claudeChatCompletion : chatCompletion;
}

/** Get the default model for the provider */
function getDefaultModel(provider: Provider): string {
  return provider === 'claude' ? 'claude-sonnet-4-5-20250929' : 'gpt-5.2';
}

/** Get the cheap/fast model for the provider */
function getFastModel(provider: Provider): string {
  return provider === 'claude' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini';
}

// In-memory product identity cache — reuse across variants of the same product
const identityCache = new Map<string, ProductIdentity>();

export function clearIdentityCache() {
  identityCache.clear();
}
import {
  analyzeCompetitorIntelligence,
  calculateOptimalPrice,
  determineAnchorStrategy,
  type PricingContext,
} from './pricing-strategies';
import type {
  Product, Variant, Settings, ProductIdentity,
  AnalysisResult, DeliberationResult,
} from '@/types';

// ============================================================================
// Step 1: AI Product Identification
// ============================================================================
export async function identifyProduct(
  product: Product,
  variant: Variant,
  model: string,
  provider: Provider = 'openai'
): Promise<ProductIdentity> {
  const descText = product.description
    || (product.description_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const userContent: Array<{ type: string; text?: string; image_url?: { url: string; detail: string } }> = [];

  userContent.push({
    type: 'text',
    text: `Identify this product and determine its origin/quality tier:

PRODUCT TITLE: ${product.title}

PRODUCT DESCRIPTION:
${descText || 'No description available'}

METADATA:
- Vendor/Brand: ${product.vendor || 'Unknown'}
- Product Type: ${product.product_type || 'Unknown'}
- Tags: ${product.tags || 'None'}
- Variant: ${variant.title || 'Default'}
- SKU: ${variant.sku || 'Unknown'}
- Current Price: $${variant.price?.toFixed(2) || 'Unknown'}
- Compare At Price: ${variant.compare_at_price ? '$' + variant.compare_at_price.toFixed(2) : 'None'}

CRITICAL: Analyze ALL of the above information to determine:
1. What this product ACTUALLY is (not just what the title says)
2. Whether this is IMPORT (China mass-produced), DOMESTIC (USA-made), or HEADY (handmade art)
3. Key features that affect pricing (material, size, brand reputation, uniqueness)
${!product.image_url ? '\nNOTE: No product image available. Rely on title, description, and metadata.' : ''}`,
  });

  if (product.image_url) {
    let imageUrl = product.image_url;
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    imageUrl = imageUrl.replace(/_\d+x\d*\./, '.');
    userContent.push({
      type: 'image_url',
      image_url: { url: imageUrl, detail: 'high' },
    });
  }

  const systemPrompt = `You are an expert in smoke shop products, heady glass, dab tools, and concentrate accessories.
Identify what this product is, its quality/origin tier, and key pricing factors.

Three tiers:
1. "import" - China/overseas mass-produced ($5-50, generic, no artist name)
2. "domestic" - USA/American-made quality ($30-200+, American brands)
3. "heady" - Handmade art/artisan ($100-1000+, artist name, one-of-a-kind)

Respond in JSON:
{
  "productType": "specific product category",
  "brand": "brand name or null",
  "identifiedAs": "plain English description of what this is",
  "productSummary": "2-3 sentence description for a human reviewer",
  "keyFeatures": ["feature1", "feature2", "feature3"],
  "originTier": "import" | "domestic" | "heady",
  "originReasoning": "brief explanation",
  "qualityIndicators": ["indicator1", "indicator2"],
  "pricingFactors": "what aspects should influence price",
  "searchQueries": ["query1", "query2", "query3"],
  "confidence": "high" | "medium" | "low",
  "notes": "relevant observations or null"
}`;

  const complete = getCompletionFn(provider);
  const raw = await complete({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent as never },
    ],
    maxTokens: 1200,
    jsonMode: true,
    reasoningEffort: 'high',
  });

  return parseAIJson<ProductIdentity>(raw);
}

// ============================================================================
// Step 2: AI Pricing Analysis (Expert-Level with Advanced Strategies)
// ============================================================================
export async function analyzePricing(
  product: Product,
  variant: Variant,
  competitorData: CompetitorSearchResult,
  identity: ProductIdentity,
  settings: Settings,
  model: string,
  provider: Provider = 'openai'
): Promise<AnalysisResult> {
  const cost = variant.cost || 0;
  const currentPrice = variant.price;
  const msrp = variant.compare_at_price;
  const originTier = identity.originTier || 'unknown';

  // ============================================================================
  // ADVANCED: Calculate optimal price using pricing strategies module
  // ============================================================================
  const pricingContext: PricingContext = {
    cost,
    currentPrice,
    msrp,
    identity,
    competitors: competitorData.competitors,
    settings,
  };

  const optimalPriceResult = calculateOptimalPrice(pricingContext);
  const competitorIntel = analyzeCompetitorIntelligence(competitorData.competitors, identity);
  const anchorStrategy = determineAnchorStrategy(
    optimalPriceResult.price,
    msrp,
    competitorIntel,
    settings
  );

  // Build competitor sections
  let competitorSection = '';
  if (competitorData.competitors.length > 0) {
    competitorSection = `EXTRACTED COMPETITOR PRICES (${competitorData.competitors.length} found):
${competitorData.competitors.map((c, i) =>
  `${i + 1}. ${c.source}: $${c.price.toFixed(2)}${c.isKnownRetailer ? ' [VERIFIED RETAILER]' : ''} [Weight: ${c.isKnownRetailer ? 'HIGH' : 'MEDIUM'}]
   URL: ${c.url}
   Title: ${c.title}
   Extraction: ${c.extractionMethod}`
).join('\n\n')}

COMPETITOR INTELLIGENCE SUMMARY:
- Weighted Median Price: $${competitorIntel.weightedMedian.toFixed(2)}
- Price Range: $${competitorIntel.priceFloor.toFixed(2)} - $${competitorIntel.priceCeiling.toFixed(2)}
- Competitive Zone (25th-75th %): $${competitorIntel.competitiveRange.low.toFixed(2)} - $${competitorIntel.competitiveRange.high.toFixed(2)}
- Data Reliability: ${competitorIntel.reliability.toUpperCase()}
${competitorIntel.marketGap ? `- MARKET GAP OPPORTUNITY: $${competitorIntel.marketGap.toFixed(2)} (no direct competition)` : ''}
${competitorIntel.dominantPricePoint ? `- Dominant Price Point: $${competitorIntel.dominantPricePoint}` : ''}`;
  }

  if (competitorData.rawResults.length > 0) {
    competitorSection += `\n\nADDITIONAL SEARCH RESULTS (${competitorData.rawResults.length} found):
${competitorData.rawResults.slice(0, 12).map((r, i) => {
  let domain: string;
  try {
    domain = new URL(r.url).hostname.replace('www.', '');
  } catch {
    domain = 'unknown';
  }
  return `${i + 1}. ${domain}
   Title: ${r.title}
   Snippet: ${(r.description || '').slice(0, 250)}`;
}).join('\n\n')}`;
  }

  if (!competitorSection) {
    competitorSection = 'NO COMPETITOR RESULTS FOUND - Use cost-based and tier-based pricing.';
  }

  // ============================================================================
  // EXPERT-LEVEL AI PROMPT
  // ============================================================================
  const systemPrompt = `You are a SENIOR E-COMMERCE PRICING STRATEGIST with 15+ years of experience optimizing retail pricing. Your expertise includes:
- Price elasticity modeling
- Psychological pricing tactics
- Competitive positioning strategy
- Profit margin optimization
- Value-based pricing for specialty products

You're pricing for: ${settings.product_niche || 'a specialty smoke shop (heady glass, dab tools, concentrate accessories)'}

PRODUCT CONTEXT:
- Quality Tier: "${originTier.toUpperCase()}"
- Product: ${identity.identifiedAs || 'Unknown'}
- Key Value Drivers: ${(identity.keyFeatures || []).join(', ')}
- Brand/Vendor: ${product.vendor || 'Unbranded'}

PRICING STRATEGY FRAMEWORK:

1. MARKET POSITION STRATEGY
   - IMPORT (China mass-produced): Value-leader or competitive positioning. Price in lower 25-50% of market.
   - DOMESTIC (USA-made): Competitive or premium positioning. Price at market median or slightly above.
   - HEADY (Artisan/handmade): Premium or luxury positioning. Price in upper 75-90% of market.

2. PROFIT OPTIMIZATION
   - Target markups by tier: Import 2-4x, Domestic 2-3x, Heady 3-10x
   - Balance volume vs. margin based on tier
   - Never sacrifice minimum margin requirements

3. PSYCHOLOGICAL PRICING
   - Use .99 endings for value positioning (effective under $100)
   - Use round numbers ($50, $100) for premium/heady items
   - Respect price thresholds ($99 vs $100 has significant impact)
   - Apply left-digit effect ($39 vs $40)

4. COMPETITIVE INTELLIGENCE
   - Weight verified retailers more heavily than unknown sources
   - Consider price clustering (where competitors cluster = market equilibrium)
   - Identify gaps in the market as opportunities
   - Don't blindly match lowest price - consider positioning

5. VALUE-BASED ADJUSTMENTS
   - Unique features justify premium
   - Brand recognition commands higher prices
   - Limited availability/exclusivity supports premium pricing
   - Quality indicators (materials, craftsmanship) affect perceived value

ALGORITHMIC RECOMMENDATION (from pricing engine):
- Optimal Price: $${optimalPriceResult.price.toFixed(2)}
- Strategy: ${optimalPriceResult.strategy}
- Confidence: ${optimalPriceResult.confidence}
- Profit Margin: ${optimalPriceResult.profitMargin.toFixed(1)}%
- Psychological Factors: ${optimalPriceResult.psychologicalFactors.join(', ')}
${anchorStrategy.useAnchor ? `- MSRP Anchor: $${anchorStrategy.suggestedMsrp?.toFixed(2)} (${anchorStrategy.anchorDiscount.toFixed(0)}% perceived savings)` : ''}

${settings.ai_unrestricted ? `🧠 AI UNRESTRICTED MODE ACTIVE
You have COMPLETE FREEDOM to recommend any price you believe is optimal.
NO constraints apply - use your expert judgment to determine the best price.
Focus purely on market positioning, profit optimization, and competitive strategy.
Rounding style preference: ${settings.rounding_style}` : `CONSTRAINTS (Must follow):
- Minimum margin: ${settings.min_margin}% OR $${settings.min_margin_dollars} (whichever is higher)
- ${settings.respect_msrp ? 'MSRP ceiling: Never exceed MSRP' : 'MSRP: May exceed if market supports'}
- Max ${settings.max_above}% above highest competitor
- Max price change: +${settings.max_increase}% / -${settings.max_decrease}%
- Rounding style: ${settings.rounding_style}`}

YOUR TASK:
Analyze all data, validate or adjust the algorithmic recommendation, and provide the OPTIMAL price that maximizes profit while maintaining competitive positioning.

Respond in JSON:
{
  "suggestedPrice": number,
  "confidence": "high" | "medium" | "low",
  "confidenceReason": "detailed explanation",
  "summary": "2-3 sentence executive summary of recommendation",
  "reasoning": [
    "Step 1: Market analysis...",
    "Step 2: Competitive positioning...",
    "Step 3: Profit optimization...",
    "Step 4: Psychological pricing...",
    "Step 5: Final price determination..."
  ],
  "productMatch": {
    "identifiedAs": "specific product description",
    "originTier": "import|domestic|heady",
    "matchConfidence": "high|medium|low",
    "matchNotes": "notes on product identification"
  },
  "competitorAnalysis": {
    "kept": [{"source": "retailer", "url": "URL", "price": number, "productMatch": "exact|similar|equivalent", "tierMatch": "same|different", "reason": "why included", "weight": "high|medium|low"}],
    "excluded": [{"source": "domain", "url": "URL", "reason": "specific exclusion reason"}],
    "low": number|null,
    "median": number|null,
    "high": number|null,
    "retailCount": number
  },
  "priceFloor": number,
  "priceCeiling": number,
  "marketPosition": "value-leader|competitive|premium|luxury",
  "expertInsights": {
    "keyOpportunity": "main pricing opportunity identified",
    "riskFactors": ["potential risk 1", "potential risk 2"],
    "alternativeStrategy": "what would change if different positioning desired"
  }
}`;

  const descText = (product.description || product.description_html?.replace(/<[^>]*>/g, ' ') || '').substring(0, 500);

  const userPrompt = `Perform expert pricing analysis:

PRODUCT DETAILS:
- Title: ${product.title}
- Variant: ${variant.title || 'Default'} (SKU: ${variant.sku || 'N/A'})
- Vendor/Brand: ${product.vendor || 'Unknown'}
- Product Type: ${product.product_type || 'Unknown'}
- Current Price: $${currentPrice.toFixed(2)}
- Cost: ${cost > 0 ? '$' + cost.toFixed(2) + ` (current gross margin: ${((currentPrice - cost) / currentPrice * 100).toFixed(1)}%)` : 'UNKNOWN - use tier-based estimation'}
${msrp ? `- MSRP/Compare-At: $${msrp.toFixed(2)}` : ''}
${descText ? `\nDescription:\n${descText}` : ''}

AI PRODUCT IDENTIFICATION:
- Identified As: ${identity.identifiedAs}
- Category: ${identity.productType}
- Quality Tier: ${originTier.toUpperCase()}
- Tier Reasoning: ${identity.originReasoning}
- Key Features: ${(identity.keyFeatures || []).join(', ')}
- Quality Indicators: ${(identity.qualityIndicators || []).join(', ')}
- Pricing Factors: ${identity.pricingFactors || 'None specified'}

${competitorSection}

STRATEGIC QUESTIONS TO CONSIDER:
1. Is the algorithmic recommendation of $${optimalPriceResult.price.toFixed(2)} optimal, or should it be adjusted?
2. What market position best fits this product given its tier and features?
3. Are there pricing psychology opportunities being missed?
4. What's the profit-maximizing price within constraints?
5. What risks exist at the suggested price point?

Provide your expert analysis and final price recommendation.`;

  const complete = getCompletionFn(provider);
  const raw = await complete({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 4000,
    jsonMode: true,
    reasoningEffort: 'high',
  });

  const result = parseAIJson<AnalysisResult>(raw);

  // Enrich result with pricing strategy data
  result.pricingStrategy = {
    strategyType: optimalPriceResult.strategy as 'value-leader' | 'competitive' | 'premium' | 'luxury',
    profitMargin: optimalPriceResult.profitMargin,
    profitDollars: optimalPriceResult.profitDollars,
    psychologicalFactors: optimalPriceResult.psychologicalFactors,
    competitorIntelligence: {
      weightedMedian: competitorIntel.weightedMedian,
      reliability: competitorIntel.reliability,
      marketGap: competitorIntel.marketGap,
    },
    anchorStrategy: anchorStrategy.useAnchor ? {
      useAnchor: true,
      suggestedMsrp: anchorStrategy.suggestedMsrp,
      anchorDiscount: anchorStrategy.anchorDiscount,
    } : undefined,
  };

  return result;
}

// ============================================================================
// Step 3: Deep Deliberation (Expert-Level when competitor data is insufficient)
// ============================================================================
export async function deliberatePricing(
  product: Product,
  variant: Variant,
  initialAnalysis: AnalysisResult,
  identity: ProductIdentity,
  settings: Settings,
  model: string,
  provider: Provider = 'openai'
): Promise<DeliberationResult> {
  const cost = variant.cost || 0;
  const currentPrice = variant.price;
  const msrp = variant.compare_at_price;
  const originTier = identity.originTier || 'unknown';
  const descText = (product.description || product.description_html?.replace(/<[^>]*>/g, ' ') || '').substring(0, 600);

  // Calculate cost-based optimal even without competitors
  const pricingContext: PricingContext = {
    cost,
    currentPrice,
    msrp,
    identity,
    competitors: [], // Empty for deliberation
    settings,
  };
  const fallbackOptimal = calculateOptimalPrice(pricingContext);

  const messageContent: Array<{ type: string; text?: string; image_url?: { url: string; detail: string } }> = [];

  messageContent.push({
    type: 'text',
    text: `You are a MASTER PRICING STRATEGIST with deep expertise in specialty retail. Initial analysis found INSUFFICIENT competitor data. You must determine the OPTIMAL price using expert knowledge and all available signals.

${product.image_url ? 'CRITICAL: A product image is attached. Perform thorough visual analysis for quality indicators, materials, craftsmanship, and brand signals.' : 'No image available - rely on text signals.'}

PRODUCT DATA:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title: ${product.title}
Variant: ${variant.title || 'Default'}
Vendor/Brand: ${product.vendor || 'Unknown'}
Product Type: ${identity.productType || product.product_type || 'Unknown'}
Quality Tier: ${originTier.toUpperCase()}

Description:
${descText || 'No description available'}

Identified As: ${identity.identifiedAs || 'Unknown'}
Key Features: ${(identity.keyFeatures || []).join(', ') || 'None identified'}
Quality Indicators: ${(identity.qualityIndicators || []).join(', ') || 'None identified'}
Pricing Factors: ${identity.pricingFactors || 'None specified'}

FINANCIAL DATA:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Price: $${currentPrice.toFixed(2)}
Cost: ${cost > 0 ? '$' + cost.toFixed(2) : 'UNKNOWN'}
${cost > 0 ? `Current Margin: ${((currentPrice - cost) / cost * 100).toFixed(1)}%` : ''}
MSRP/Compare At: ${msrp ? '$' + msrp.toFixed(2) : 'None'}

INITIAL ANALYSIS (insufficient data):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Suggested: $${initialAnalysis.suggestedPrice?.toFixed(2) || 'None'}
Confidence: ${initialAnalysis.confidence || 'low'}
Competitors Found: ${initialAnalysis.competitorAnalysis?.retailCount || 0}

ALGORITHMIC FALLBACK ESTIMATE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Cost-Based Price: $${fallbackOptimal.price.toFixed(2)}
Strategy: ${fallbackOptimal.strategy}
Reasoning: ${fallbackOptimal.reasoning.slice(0, 3).join(' | ')}

EXPERT PRICING FRAMEWORK:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. VISUAL ASSESSMENT (if image available):
   - Material quality (glass thickness, clarity, impurities)
   - Craftsmanship (seams, symmetry, finish quality)
   - Brand indicators (logos, signatures, artist marks)
   - Complexity (simple vs. intricate design)
   - Size estimation

2. TIER-BASED PRICING RANGES:
   IMPORT: $5-50 (commodity), markup 2-4x cost
   DOMESTIC: $20-150 (quality), markup 2-3x cost
   HEADY: $50-500+ (art), markup 3-10x cost

3. VALUE MULTIPLIERS:
   - Known brand: +15-30%
   - Artist signature: +50-200%
   - Limited edition: +25-50%
   - Unique/one-of-a-kind: +100-500%
   - Premium materials (quartz, thick glass): +10-25%

4. PSYCHOLOGICAL PRICE POINTS:
   - Under $25: Use .99 endings
   - $25-100: Use .99 or round to $5
   - $100+: Use round numbers for premium feel

${settings.ai_unrestricted ? `5. 🧠 AI UNRESTRICTED MODE:
   - NO CONSTRAINTS - use pure expert judgment
   - Recommend the price YOU believe is truly optimal
   - Focus on market positioning and profit optimization
   - Rounding preference: ${settings.rounding_style}` : `5. CONSTRAINTS:
   - Min margin: ${settings.min_margin}% or $${settings.min_margin_dollars}
   - ${settings.respect_msrp ? 'Must not exceed MSRP' : 'May exceed MSRP if justified'}
   - Max change: +${settings.max_increase}% / -${settings.max_decrease}%
   - Rounding: ${settings.rounding_style}`}

YOUR MISSION:
Synthesize ALL available information to determine the OPTIMAL price. Be confident - you have enough data to make an informed decision.

Respond in JSON:
{
  "deliberatedPrice": number,
  "confidence": "high"|"medium"|"low",
  "confidenceReason": "detailed justification",
  "visualAnalysis": "thorough visual assessment or 'No image available'",
  "reasoning": {
    "costAnalysis": "cost-based calculation and markup applied",
    "categoryNorms": "how this fits within tier/category pricing",
    "currentPriceAssessment": "is current price appropriate, too high, or too low",
    "marginCheck": "verification that margin requirements are met",
    "finalDecision": "synthesized reasoning for final price"
  },
  "priceFloor": number,
  "priceCeiling": number,
  "alternativeConsiderations": "what factors could change this recommendation",
  "suggestedAction": "keep"|"increase"|"decrease",
  "expertNotes": "any additional strategic insights"
}`,
  });

  if (product.image_url) {
    let imageUrl = product.image_url;
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    imageUrl = imageUrl.replace(/_\d+x\d*\./, '.');
    messageContent.push({
      type: 'image_url',
      image_url: { url: imageUrl, detail: 'high' },
    });
  }

  const complete = getCompletionFn(provider);
  const raw = await complete({
    model,
    messages: [
      {
        role: 'system',
        content: `You are a MASTER PRICING STRATEGIST specializing in specialty retail. You have 20+ years of experience pricing products in niche markets. You NEVER say "I cannot determine a price" - you always provide a concrete, justified recommendation based on available signals. Use visual analysis, cost data, category knowledge, brand signals, and business logic to determine optimal pricing.`,
      },
      { role: 'user', content: messageContent as never },
    ],
    maxTokens: 3000,
    jsonMode: true,
    reasoningEffort: 'xhigh', // Maximum reasoning for deep deliberation
  });

  return parseAIJson<DeliberationResult>(raw);
}

// ============================================================================
// Step 4: AI Reflection (generate new search queries when initial search fails)
// ============================================================================
async function reflectAndRetry(
  product: Product,
  identity: ProductIdentity,
  failedQueries: string[],
  model: string,
  provider: Provider = 'openai'
): Promise<string[]> {
  const descText = (product.description || '').substring(0, 300);

  const prompt = `Previous searches for competitor pricing returned NO valid data.

PRODUCT: ${product.title}
Type: ${identity.productType || 'Unknown'}
Identified as: ${identity.identifiedAs || 'Unknown'}
Tier: ${identity.originTier || 'unknown'}
Description: ${descText || 'None'}

FAILED QUERIES:
${failedQueries.slice(0, 10).map((q, i) => `${i + 1}. "${q}"`).join('\n')}

Generate 8 NEW, DIFFERENT search queries using:
- Common product names (not brand-specific)
- Synonyms and alternative terms
- Broader categories
- Specific retailer site searches

Respond in JSON:
{ "newQueries": ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"] }`;

  try {
    const complete = getCompletionFn(provider);
    const raw = await complete({
      model,
      messages: [
        { role: 'system', content: 'Generate effective search queries for e-commerce product pricing research.' },
        { role: 'user', content: prompt },
      ],
      maxTokens: 500,
      jsonMode: true,
      reasoningEffort: 'medium',
    });

    const result = parseAIJson<{ newQueries: string[] }>(raw);
    return result.newQueries || [];
  } catch {
    return [];
  }
}

// ============================================================================
// Full Analysis Pipeline — orchestrates all steps for a single variant
// ============================================================================
export async function runFullAnalysis(
  product: Product,
  variant: Variant,
  settings: Settings,
  onProgress?: (step: string) => void,
  searchMode: SearchMode = 'brave',
  provider: Provider = 'openai',
  fast: boolean = false,
): Promise<{
  suggestedPrice: number | null;
  confidence: string | null;
  confidenceReason: string | null;
  summary: string | null;
  reasoning: string[] | null;
  marketPosition: string | null;
  priceFloor: number | null;
  priceCeiling: number | null;
  productIdentity: ProductIdentity | null;
  competitorAnalysis: AnalysisResult['competitorAnalysis'] | null;
  searchQueries: string[];
  wasDeliberated: boolean;
  wasReflectionRetried: boolean;
  error: string | null;
}> {
  // Fast mode: use cheapest models, skip reflection + deliberation
  const model = fast
    ? getFastModel(provider)
    : (provider === 'claude' ? getDefaultModel('claude') : (settings.openai_model || 'gpt-5.2'));
  const reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' = fast ? 'low' : 'high';

  try {
    // Step 1: Identify product (cached per product — all variants share identity)
    let identity: ProductIdentity;
    const cached = identityCache.get(product.id);
    if (cached) {
      onProgress?.('Using cached product identity...');
      identity = cached;
    } else {
      onProgress?.(`Identifying product (${fast ? 'fast' : provider})...`);
      identity = await identifyProduct(product, variant, model, provider);
      identityCache.set(product.id, identity);
    }

    // Step 2: Search competitors
    let competitorData: CompetitorSearchResult;
    const productSearch = { title: product.title, vendor: product.vendor, productType: product.product_type };
    if (searchMode === 'none') {
      onProgress?.('Skipping competitor search...');
      competitorData = { competitors: [], rawResults: [], excluded: [], queries: [] };
    } else if (searchMode === 'amazon') {
      if (provider === 'claude') {
        onProgress?.('Searching Amazon (Claude web search)...');
        competitorData = await searchCompetitorsClaudeAmazon(productSearch, identity);
      } else {
        onProgress?.('Searching Amazon (OpenAI web search)...');
        competitorData = await searchCompetitorsAmazon(productSearch, identity);
      }
    } else if (searchMode === 'brave') {
      onProgress?.('Searching competitors (Brave)...');
      competitorData = await searchCompetitors(productSearch, identity, 3);
    } else {
      // searchMode === 'openai' (default) — route to provider's web search
      if (provider === 'claude') {
        onProgress?.('Searching competitors (Claude web search)...');
        competitorData = await searchCompetitorsClaude(productSearch, identity);
      } else {
        onProgress?.('Searching competitors (OpenAI web search)...');
        competitorData = await searchCompetitorsOpenAI(productSearch, identity);
      }
    }

    // Step 3: AI pricing analysis
    onProgress?.(`Analyzing pricing (${fast ? 'fast' : provider})...`);
    let analysis = await analyzePricing(product, variant, competitorData, identity, settings, model, provider);

    let wasDeliberated = false;
    let wasReflectionRetried = false;

    // Steps 4-5: Reflection + Deliberation — SKIP in fast mode
    if (!fast) {
      // Step 4: If insufficient data, try AI reflection + retry
      const hasInsufficientData = (analysis.competitorAnalysis?.retailCount || 0) < 2;
      const hasLowConfidence = analysis.confidence === 'low';

      if (hasInsufficientData && searchMode !== 'none' && competitorData.queries.length > 0) {
        onProgress?.('AI reflection on search strategy...');
        const newQueries = await reflectAndRetry(product, identity, competitorData.queries, model, provider);

        if (newQueries.length > 0) {
          onProgress?.('Retrying with AI-suggested searches...');
          let retryData: CompetitorSearchResult;
          const retryIdentity = { ...identity, searchQueries: newQueries };
          if (searchMode === 'amazon') {
            retryData = provider === 'claude'
              ? await searchCompetitorsClaudeAmazon(productSearch, retryIdentity)
              : await searchCompetitorsAmazon(productSearch, retryIdentity);
          } else if (searchMode === 'brave') {
            const { searchCompetitors: sc } = await import('./competitors');
            retryData = await sc(productSearch, retryIdentity, 1);
          } else {
            retryData = provider === 'claude'
              ? await searchCompetitorsClaude(productSearch, retryIdentity)
              : await searchCompetitorsOpenAI(productSearch, retryIdentity);
          }

          // Merge new results
          for (const comp of retryData.competitors) {
            if (!competitorData.competitors.some(c => c.price === comp.price)) {
              competitorData.competitors.push(comp);
            }
          }
          competitorData.queries.push(...newQueries);

          if (retryData.competitors.length > 0) {
            onProgress?.('Re-analyzing with new data...');
            const reanalysis = await analyzePricing(product, variant, competitorData, identity, settings, model, provider);
            if ((reanalysis.competitorAnalysis?.retailCount || 0) > (analysis.competitorAnalysis?.retailCount || 0)) {
              analysis = reanalysis;
              wasReflectionRetried = true;
            }
          }
        }
      }

      // Step 5: Deep deliberation if still uncertain
      if (hasInsufficientData || hasLowConfidence || !analysis.suggestedPrice) {
        onProgress?.('Deep deliberation...');
        const deliberation = await deliberatePricing(product, variant, analysis, identity, settings, model, provider);
        if (deliberation.deliberatedPrice) {
          analysis.suggestedPrice = deliberation.deliberatedPrice;
          analysis.confidence = deliberation.confidence;
          analysis.confidenceReason = deliberation.confidenceReason;
          analysis.priceFloor = deliberation.priceFloor || analysis.priceFloor;
          analysis.priceCeiling = deliberation.priceCeiling || analysis.priceCeiling;
          analysis.reasoning = [
            ...(analysis.reasoning || []),
            `DELIBERATION: ${deliberation.reasoning?.finalDecision || 'Price set via deep analysis'}`,
          ];
          wasDeliberated = true;
        }
      }
    } // end if (!fast)

    return {
      suggestedPrice: analysis.suggestedPrice,
      confidence: analysis.confidence,
      confidenceReason: analysis.confidenceReason,
      summary: analysis.summary,
      reasoning: analysis.reasoning,
      marketPosition: analysis.marketPosition,
      priceFloor: analysis.priceFloor,
      priceCeiling: analysis.priceCeiling,
      productIdentity: identity,
      competitorAnalysis: analysis.competitorAnalysis,
      searchQueries: competitorData.queries,
      wasDeliberated,
      wasReflectionRetried,
      error: null,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown analysis error';
    console.error(`Analysis failed for ${product.title} / ${variant.title}:`, message);
    return {
      suggestedPrice: null,
      confidence: null,
      confidenceReason: null,
      summary: null,
      reasoning: null,
      marketPosition: null,
      priceFloor: null,
      priceCeiling: null,
      productIdentity: null,
      competitorAnalysis: null,
      searchQueries: [],
      wasDeliberated: false,
      wasReflectionRetried: false,
      error: message,
    };
  }
}

// Save analysis result to Supabase
export async function saveAnalysis(
  productId: string,
  variantId: string,
  result: Awaited<ReturnType<typeof runFullAnalysis>>,
  volumeMeta?: {
    pricing_method: 'ai' | 'volume_formula';
    volume_pricing: import('@/types').VolumePricingMeta | null;
  },
) {
  const db = createServerClient();

  // Delete any existing analysis for this variant
  await db.from('analyses').delete().match({ product_id: productId, variant_id: variantId });

  const { error } = await db.from('analyses').insert({
    product_id: productId,
    variant_id: variantId,
    suggested_price: result.suggestedPrice,
    confidence: result.confidence,
    confidence_reason: result.confidenceReason,
    summary: result.summary,
    reasoning: result.reasoning,
    market_position: result.marketPosition,
    price_floor: result.priceFloor,
    price_ceiling: result.priceCeiling,
    product_identity: result.productIdentity,
    competitor_analysis: result.competitorAnalysis,
    search_queries: result.searchQueries,
    was_deliberated: result.wasDeliberated,
    was_reflection_retried: result.wasReflectionRetried,
    applied: false,
    error: result.error,
    analyzed_at: new Date().toISOString(),
    pricing_method: volumeMeta?.pricing_method || 'ai',
    volume_pricing: volumeMeta?.volume_pricing || null,
  });

  if (error) {
    console.error('Failed to save analysis:', error);
    throw new Error(`Database error: ${error.message}`);
  }
}

// ============================================================================
// Volume-Aware Analysis — only AI-analyze the base (lowest qty) variant,
// then derive all other quantity variants using the power-law formula.
// ============================================================================

import {
  detectQuantityVariantGroups,
  calculateVolumePrices,
  buildVolumeAnalysisReasoning,
  DEFAULT_CONFIG,
  type VolumePricingConfig,
  type QuantityVariantGroup,
  type VolumePriceResult,
  type VolumePricingOutput,
} from './volume-pricing';
import type { VolumePricingMeta } from '@/types';

export type { QuantityVariantGroup } from './volume-pricing';

/**
 * Run full analysis for a product, volume-aware.
 *
 * If the product has quantity-type variants:
 *   1. Only the lowest-quantity variant is analyzed through the AI pipeline.
 *   2. All other quantity variants get their price derived via the power-law
 *      volume discount formula.
 *
 * Returns results for ALL variants (base + derived).
 *
 * If the product does NOT have quantity variants, runs normal AI analysis for
 * the single requested variant and returns just that one result.
 */
export async function runVolumeAwareAnalysis(
  product: Product,
  allVariants: Variant[],
  targetVariantId: string,
  settings: Settings,
  options: {
    onProgress?: (step: string) => void;
    searchMode?: SearchMode;
    provider?: Provider;
    fast?: boolean;
    volumeConfig?: Partial<VolumePricingConfig>;
  } = {},
): Promise<{
  results: Array<{
    variantId: string;
    productId: string;
    analysisResult: Awaited<ReturnType<typeof runFullAnalysis>>;
    volumeMeta: { pricing_method: 'ai' | 'volume_formula'; volume_pricing: VolumePricingMeta | null };
  }>;
  quantityGroups: QuantityVariantGroup[] | null;
}> {
  const {
    onProgress,
    searchMode = 'brave',
    provider = 'openai',
    fast = false,
    volumeConfig = {},
  } = options;

  // Step 1: Detect quantity variant groups
  const groups = detectQuantityVariantGroups(allVariants);

  if (!groups) {
    // Not a quantity-based product — run normal AI analysis on the target variant
    const variant = allVariants.find(v => v.id === targetVariantId);
    if (!variant) {
      throw new Error(`Target variant ${targetVariantId} not found in product variants`);
    }

    const result = await runFullAnalysis(product, variant, settings, onProgress, searchMode, provider, fast);
    return {
      results: [{
        variantId: variant.id,
        productId: product.id,
        analysisResult: result,
        volumeMeta: { pricing_method: 'ai', volume_pricing: null },
      }],
      quantityGroups: null,
    };
  }

  // Step 2: Find which group contains the target variant
  let targetGroup: QuantityVariantGroup | null = null;
  for (const g of groups) {
    if (g.variants.some(qv => qv.variant.id === targetVariantId)) {
      targetGroup = g;
      break;
    }
  }

  if (!targetGroup) {
    // Target variant is not part of any quantity group (e.g. it's a standalone variant)
    const variant = allVariants.find(v => v.id === targetVariantId);
    if (!variant) {
      throw new Error(`Target variant ${targetVariantId} not found`);
    }
    const result = await runFullAnalysis(product, variant, settings, onProgress, searchMode, provider, fast);
    return {
      results: [{
        variantId: variant.id,
        productId: product.id,
        analysisResult: result,
        volumeMeta: { pricing_method: 'ai', volume_pricing: null },
      }],
      quantityGroups: groups,
    };
  }

  // Step 3: AI-analyze only the base (lowest qty) variant
  const baseVariant = targetGroup.baseVariant.variant;
  const baseQty = targetGroup.baseVariant.quantity;

  onProgress?.(`Quantity variants detected (${targetGroup.variants.map(v => v.quantity).join(', ')}). AI-analyzing base tier (qty ${baseQty})...`);

  const baseResult = await runFullAnalysis(product, baseVariant, settings, onProgress, searchMode, provider, fast);

  if (baseResult.error || !baseResult.suggestedPrice) {
    // Base analysis failed — can't derive other tiers. Return only base result.
    return {
      results: [{
        variantId: baseVariant.id,
        productId: product.id,
        analysisResult: baseResult,
        volumeMeta: { pricing_method: 'ai', volume_pricing: null },
      }],
      quantityGroups: groups,
    };
  }

  // Step 4: Calculate volume prices for all tiers in this group
  const tiers = targetGroup.variants.map(qv => ({
    variantId: qv.variant.id,
    quantity: qv.quantity,
  }));

  const cfg: Partial<VolumePricingConfig> = { ...volumeConfig };
  const volumeOutput = calculateVolumePrices(baseResult.suggestedPrice, baseQty, tiers, cfg);

  if (volumeOutput.warnings.length > 0) {
    onProgress?.(`Volume pricing warnings: ${volumeOutput.warnings.join('; ')}`);
  }

  // Step 5: Build analysis results for all variants
  const allResults: Array<{
    variantId: string;
    productId: string;
    analysisResult: Awaited<ReturnType<typeof runFullAnalysis>>;
    volumeMeta: { pricing_method: 'ai' | 'volume_formula'; volume_pricing: VolumePricingMeta | null };
  }> = [];

  for (const priceResult of volumeOutput.results) {
    if (priceResult.isBase) {
      // Base variant — uses AI analysis result directly
      allResults.push({
        variantId: priceResult.variantId,
        productId: product.id,
        analysisResult: baseResult,
        volumeMeta: {
          pricing_method: 'ai',
          volume_pricing: {
            base_variant_id: baseVariant.id,
            base_price: baseResult.suggestedPrice,
            base_qty: baseQty,
            variant_qty: baseQty,
            exponent: volumeOutput.exponent,
            rounding_method: volumeOutput.roundingMethod,
            raw_price: baseResult.suggestedPrice,
            per_unit: priceResult.perUnit,
            discount_from_base_percent: 0,
            premium_multiplier: null,
          },
        },
      });
    } else {
      // Derived variant — price calculated via formula
      const reasoning = buildVolumeAnalysisReasoning(priceResult, volumeOutput);

      const derivedResult: Awaited<ReturnType<typeof runFullAnalysis>> = {
        suggestedPrice: priceResult.calculatedPrice,
        confidence: baseResult.confidence, // Inherits base confidence
        confidenceReason: `Derived from base variant (qty ${baseQty}) at $${baseResult.suggestedPrice.toFixed(2)} using power-law volume discount (exponent ${volumeOutput.exponent}).`,
        summary: `Volume discount price: $${priceResult.calculatedPrice.toFixed(2)} for ${priceResult.quantity} units ($${priceResult.perUnit.toFixed(4)}/unit, ${priceResult.discountFromBasePercent}% discount from base).`,
        reasoning,
        marketPosition: baseResult.marketPosition,
        priceFloor: null,
        priceCeiling: null,
        productIdentity: baseResult.productIdentity,
        competitorAnalysis: null, // No separate competitor data for derived variants
        searchQueries: [],
        wasDeliberated: false,
        wasReflectionRetried: false,
        error: null,
      };

      onProgress?.(`Derived qty ${priceResult.quantity}: $${priceResult.calculatedPrice.toFixed(2)} (${priceResult.discountFromBasePercent}% discount)`);

      allResults.push({
        variantId: priceResult.variantId,
        productId: product.id,
        analysisResult: derivedResult,
        volumeMeta: {
          pricing_method: 'volume_formula',
          volume_pricing: {
            base_variant_id: baseVariant.id,
            base_price: baseResult.suggestedPrice,
            base_qty: baseQty,
            variant_qty: priceResult.quantity,
            exponent: volumeOutput.exponent,
            rounding_method: volumeOutput.roundingMethod,
            raw_price: priceResult.rawPrice,
            per_unit: priceResult.perUnit,
            discount_from_base_percent: priceResult.discountFromBasePercent,
            premium_multiplier: null,
          },
        },
      });
    }
  }

  return {
    results: allResults,
    quantityGroups: groups,
  };
}

/**
 * Check if a set of variants contains quantity-type variants.
 * Utility for callers that need to pre-check before deciding on analysis strategy.
 */
export { detectQuantityVariantGroups } from './volume-pricing';
