// Core AI pricing analysis pipeline using GPT-5.2 with reasoning
// Handles: product identification → competitor search → AI pricing → deliberation

import { chatCompletion, parseAIJson } from './openai';
import { searchCompetitors, type CompetitorSearchResult } from './competitors';
import { createServerClient } from './supabase';
import type {
  Product, Variant, Settings, ProductIdentity,
  AnalysisResult, DeliberationResult,
} from '@/types';

const WHOLESALE_DOMAINS_SHORT = [
  'alibaba.com', 'dhgate.com', 'made-in-china.com', 'wholesalecentral.com',
];

// ============================================================================
// Step 1: AI Product Identification
// ============================================================================
export async function identifyProduct(
  product: Product,
  variant: Variant,
  model: string
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

  const raw = await chatCompletion({
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
// Step 2: AI Pricing Analysis
// ============================================================================
export async function analyzePricing(
  product: Product,
  variant: Variant,
  competitorData: CompetitorSearchResult,
  identity: ProductIdentity,
  settings: Settings,
  model: string
): Promise<AnalysisResult> {
  const cost = variant.cost || 0;
  const currentPrice = variant.price;
  const originTier = identity.originTier || 'unknown';

  // Build competitor sections
  let competitorSection = '';
  if (competitorData.competitors.length > 0) {
    competitorSection = `EXTRACTED COMPETITOR PRICES (${competitorData.competitors.length} found):
${competitorData.competitors.map((c, i) =>
  `${i + 1}. ${c.source}: $${c.price.toFixed(2)}${c.isKnownRetailer ? ' [KNOWN RETAILER]' : ''}
   URL: ${c.url}
   Title: ${c.title}
   Source: ${c.extractionMethod}`
).join('\n\n')}`;
  }

  if (competitorData.rawResults.length > 0) {
    competitorSection += `\n\nADDITIONAL SEARCH RESULTS (${competitorData.rawResults.length} found):
${competitorData.rawResults.slice(0, 15).map((r, i) =>
  `${i + 1}. ${new URL(r.url).hostname.replace('www.', '')}
   URL: ${r.url}
   Title: ${r.title}
   Description: ${(r.description || '').slice(0, 300)}`
).join('\n\n')}`;
  }

  if (!competitorSection) {
    competitorSection = 'NO COMPETITOR RESULTS FOUND';
  }

  const systemPrompt = `You are a pricing analyst for a smoke shop (${settings.product_niche || 'heady glass, dab tools, concentrate accessories'}).

YOUR PRIMARY GOAL: Analyze competitor prices and suggest an optimal price.

Quality Tier: "${originTier}" — for notes only, never exclude competitors based on tier.
Product identified as: ${identity.identifiedAs || 'Unknown'}
Key features: ${(identity.keyFeatures || []).join(', ')}

BE MAXIMALLY INCLUSIVE WITH COMPETITORS. Only exclude:
- Wholesale/B2B sites (${WHOLESALE_DOMAINS_SHORT.join(', ')})
- Marketplace aggregators (Amazon, eBay, Etsy)
- Completely unrelated products

Pricing Rules:
- Minimum margin: ${settings.min_margin}% or $${settings.min_margin_dollars} (whichever higher)
- ${settings.respect_msrp ? 'Never exceed MSRP' : 'May exceed MSRP if justified'}
- Max ${settings.max_above}% above highest retail competitor
- Max price increase: ${settings.max_increase}%
- Max price decrease: ${settings.max_decrease}%
- Rounding: ${settings.rounding_style}

Respond in JSON:
{
  "suggestedPrice": number,
  "confidence": "high" | "medium" | "low",
  "confidenceReason": "string",
  "summary": "1-2 sentence recommendation",
  "reasoning": ["step1", "step2", "step3"],
  "productMatch": {
    "identifiedAs": "string",
    "originTier": "import|domestic|heady",
    "matchConfidence": "high|medium|low",
    "matchNotes": "string"
  },
  "competitorAnalysis": {
    "kept": [{"source": "name", "url": "URL", "price": number, "productMatch": "exact|similar|equivalent", "tierMatch": "same|different", "reason": "why kept"}],
    "excluded": [{"source": "domain", "url": "URL", "reason": "string"}],
    "low": number|null,
    "median": number|null,
    "high": number|null,
    "retailCount": number
  },
  "priceFloor": number,
  "priceCeiling": number,
  "marketPosition": "below market|at market|above market|premium|unknown"
}`;

  const descText = (product.description || product.description_html?.replace(/<[^>]*>/g, ' ') || '').substring(0, 400);

  const userPrompt = `Analyze pricing for this product:

PRODUCT: ${product.title}
Variant: ${variant.title || 'Default'} (SKU: ${variant.sku || 'N/A'})
Vendor: ${product.vendor || 'Unknown'}
Type: ${product.product_type || 'Unknown'}
Current Price: $${currentPrice.toFixed(2)}
Cost: ${cost > 0 ? '$' + cost.toFixed(2) : 'Unknown'}
${variant.compare_at_price ? `MSRP: $${variant.compare_at_price.toFixed(2)}` : ''}
${descText ? `Description: ${descText}` : ''}

AI IDENTIFICATION:
- Identified as: ${identity.identifiedAs}
- Type: ${identity.productType}
- Tier: ${originTier.toUpperCase()} — ${identity.originReasoning}
- Features: ${(identity.keyFeatures || []).join(', ')}

${competitorSection}

Instructions:
1. Extract prices from ALL search results (look for $XX.XX patterns)
2. Be maximally inclusive with competitors
3. Calculate suggested price using all data
4. Ensure margins meet requirements`;

  const raw = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 3000,
    jsonMode: true,
    reasoningEffort: 'high',
  });

  return parseAIJson<AnalysisResult>(raw);
}

// ============================================================================
// Step 3: Deep Deliberation (when competitor data is insufficient)
// ============================================================================
export async function deliberatePricing(
  product: Product,
  variant: Variant,
  initialAnalysis: AnalysisResult,
  identity: ProductIdentity,
  settings: Settings,
  model: string
): Promise<DeliberationResult> {
  const cost = variant.cost || 0;
  const currentPrice = variant.price;
  const originTier = identity.originTier || 'unknown';
  const descText = (product.description || product.description_html?.replace(/<[^>]*>/g, ' ') || '').substring(0, 500);

  const messageContent: Array<{ type: string; text?: string; image_url?: { url: string; detail: string } }> = [];

  messageContent.push({
    type: 'text',
    text: `You are a senior pricing strategist. Initial analysis found INSUFFICIENT competitor data. Determine a price using ALL available information.

${product.image_url ? 'IMPORTANT: A product image is attached. Examine it carefully for quality, materials, craftsmanship.' : 'No image available.'}

PRODUCT:
- Title: ${product.title}
- Variant: ${variant.title || 'Default'}
- Description: ${descText || 'None'}
- Vendor: ${product.vendor || 'Unknown'}
- Type: ${identity.productType || product.product_type || 'Unknown'}
- Quality Tier: ${originTier.toUpperCase()}
- Current Price: $${currentPrice.toFixed(2)}
- Cost: ${cost > 0 ? '$' + cost.toFixed(2) : 'Unknown'}
- Compare At: ${variant.compare_at_price ? '$' + variant.compare_at_price.toFixed(2) : 'None'}

INITIAL ANALYSIS:
- Suggested: $${initialAnalysis.suggestedPrice?.toFixed(2) || 'None'}
- Confidence: ${initialAnalysis.confidence}
- Competitors Found: ${initialAnalysis.competitorAnalysis?.retailCount || 0}

DETERMINE PRICE USING:
1. Visual analysis (if image provided)
2. Cost-based: import 2-4x, domestic 2-3x, heady 3-10x markup
3. Category norms: import $5-50, domestic $20-150, heady $50-500+
4. Current price evaluation
5. Minimum margin: ${settings.min_margin}% or $${settings.min_margin_dollars}

Respond in JSON:
{
  "deliberatedPrice": number,
  "confidence": "high"|"medium"|"low",
  "confidenceReason": "string",
  "visualAnalysis": "string",
  "reasoning": {
    "costAnalysis": "string",
    "categoryNorms": "string",
    "currentPriceAssessment": "string",
    "marginCheck": "string",
    "finalDecision": "string"
  },
  "priceFloor": number,
  "priceCeiling": number,
  "alternativeConsiderations": "string",
  "suggestedAction": "keep"|"increase"|"decrease"
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

  const raw = await chatCompletion({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an expert pricing strategist who NEVER gives up. You MUST provide a concrete price. Use visual analysis, cost analysis, category knowledge, and business logic.',
      },
      { role: 'user', content: messageContent as never },
    ],
    maxTokens: 2000,
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
  model: string
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
    const raw = await chatCompletion({
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
  onProgress?: (step: string) => void
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
  const model = settings.openai_model || 'gpt-5.2';

  try {
    // Step 1: Identify product
    onProgress?.('Identifying product...');
    const identity = await identifyProduct(product, variant, model);

    // Step 2: Search competitors (multi-attempt with broadening)
    onProgress?.('Searching competitors...');
    let competitorData = await searchCompetitors(
      { title: product.title, vendor: product.vendor, productType: product.product_type },
      identity,
      3
    );

    // Step 3: AI pricing analysis
    onProgress?.('Analyzing pricing...');
    let analysis = await analyzePricing(product, variant, competitorData, identity, settings, model);

    let wasDeliberated = false;
    let wasReflectionRetried = false;

    // Step 4: If insufficient data, try AI reflection + retry
    const hasInsufficientData = (analysis.competitorAnalysis?.retailCount || 0) < 2;
    const hasLowConfidence = analysis.confidence === 'low';

    if (hasInsufficientData && competitorData.queries.length > 0) {
      onProgress?.('AI reflection on search strategy...');
      const newQueries = await reflectAndRetry(product, identity, competitorData.queries, model);

      if (newQueries.length > 0) {
        onProgress?.('Retrying with AI-suggested searches...');
        const { searchCompetitors: sc } = await import('./competitors');
        const retryData = await sc(
          { title: product.title, vendor: product.vendor, productType: product.product_type },
          { ...identity, searchQueries: newQueries },
          1
        );

        // Merge new results
        for (const comp of retryData.competitors) {
          if (!competitorData.competitors.some(c => c.price === comp.price)) {
            competitorData.competitors.push(comp);
          }
        }
        competitorData.queries.push(...newQueries);

        if (retryData.competitors.length > 0) {
          onProgress?.('Re-analyzing with new data...');
          const reanalysis = await analyzePricing(product, variant, competitorData, identity, settings, model);
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
      const deliberation = await deliberatePricing(product, variant, analysis, identity, settings, model);
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
  result: Awaited<ReturnType<typeof runFullAnalysis>>
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
  });

  if (error) {
    console.error('Failed to save analysis:', error);
    throw new Error(`Database error: ${error.message}`);
  }
}
