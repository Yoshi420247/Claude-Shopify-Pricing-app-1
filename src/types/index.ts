// ============================================================================
// Database / Domain Types
// ============================================================================

export interface Settings {
  id: string;
  shopify_store: string;
  shopify_token: string | null;
  openai_key: string | null;
  openai_model: string;
  brave_key: string | null;
  min_margin: number;
  min_margin_dollars: number;
  clearance_margin: number;
  respect_msrp: boolean;
  max_above: number;
  max_increase: number;
  max_decrease: number;
  rounding_style: 'psychological' | 'clean' | 'none';
  product_niche: string | null;
  concurrency: number;
  // AI Freedom Mode - when enabled, AI gives best recommendation without constraints
  ai_unrestricted: boolean;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  title: string;
  description: string | null;
  description_html: string | null;
  vendor: string | null;
  product_type: string | null;
  handle: string | null;
  tags: string | null;
  status: string;
  image_url: string | null;
  shopify_gid: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
  variants?: Variant[];
}

export interface Variant {
  id: string;
  product_id: string;
  title: string | null;
  sku: string | null;
  price: number;
  compare_at_price: number | null;
  cost: number | null;
  inventory_item_id: string | null;
  shopify_gid: string | null;
  created_at: string;
  updated_at: string;
}

export interface Analysis {
  id: string;
  product_id: string;
  variant_id: string;
  suggested_price: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  confidence_reason: string | null;
  summary: string | null;
  reasoning: string[] | null;
  market_position: string | null;
  price_floor: number | null;
  price_ceiling: number | null;
  product_identity: ProductIdentity | null;
  competitor_analysis: CompetitorAnalysis | null;
  search_queries: string[] | null;
  was_deliberated: boolean;
  was_reflection_retried: boolean;
  applied: boolean;
  applied_at: string | null;
  previous_price: number | null;
  error: string | null;
  analyzed_at: string;
  created_at: string;
}

export interface ActivityLog {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
  created_at: string;
}

// ============================================================================
// AI Analysis Types
// ============================================================================

export interface ProductIdentity {
  productType: string;
  brand: string | null;
  identifiedAs: string;
  productSummary: string;
  keyFeatures: string[];
  originTier: 'import' | 'domestic' | 'heady';
  originReasoning: string;
  qualityIndicators: string[];
  pricingFactors: string;
  searchQueries: string[];
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}

export interface CompetitorEntry {
  source: string;
  url: string;
  price: number;
  productMatch?: 'exact' | 'similar' | 'equivalent';
  tierMatch?: 'same' | 'different';
  reason?: string;
  title?: string;
  extractionMethod?: string;
  isKnownRetailer?: boolean;
}

export interface CompetitorAnalysis {
  kept: CompetitorEntry[];
  excluded: { source: string; url?: string; reason: string }[];
  low: number | null;
  median: number | null;
  high: number | null;
  retailCount: number;
}

export interface AnalysisResult {
  suggestedPrice: number;
  confidence: 'high' | 'medium' | 'low';
  confidenceReason: string;
  summary: string;
  reasoning: string[];
  productMatch: {
    identifiedAs: string;
    originTier: string;
    matchConfidence: string;
    matchNotes: string;
  };
  competitorAnalysis: CompetitorAnalysis;
  priceFloor: number;
  priceCeiling: number;
  marketPosition: string;
  // Advanced pricing strategy fields
  pricingStrategy?: {
    strategyType: 'value-leader' | 'competitive' | 'premium' | 'luxury';
    profitMargin: number;
    profitDollars: number;
    psychologicalFactors: string[];
    competitorIntelligence: {
      weightedMedian: number;
      reliability: 'high' | 'medium' | 'low';
      marketGap: number | null;
    };
    anchorStrategy?: {
      useAnchor: boolean;
      suggestedMsrp: number | null;
      anchorDiscount: number;
    };
  };
}

export interface DeliberationResult {
  deliberatedPrice: number;
  confidence: 'high' | 'medium' | 'low';
  confidenceReason: string;
  visualAnalysis: string;
  reasoning: {
    costAnalysis: string;
    categoryNorms: string;
    currentPriceAssessment: string;
    marginCheck: string;
    finalDecision: string;
  };
  priceFloor: number;
  priceCeiling: number;
  alternativeConsiderations: string;
  suggestedAction: 'keep' | 'increase' | 'decrease';
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface SyncProductsResponse {
  success: boolean;
  productsCount: number;
  variantsCount: number;
  costsLoaded: number;
  error?: string;
}

export interface AnalyzeRequest {
  productId: string;
  variantId: string;
}

export interface AnalyzeResponse {
  success: boolean;
  analysis?: Analysis;
  error?: string;
}

export interface UpdatePriceRequest {
  productId: string;
  variantId: string;
  newPrice: number;
}

export interface BulkAnalyzeRequest {
  variantIds: { productId: string; variantId: string }[];
}

// ============================================================================
// UI State Types
// ============================================================================

export type AnalysisStatus =
  | 'needs_analysis'
  | 'analyzing'
  | 'has_suggestion'
  | 'applied'
  | 'failed';

export interface ProductWithAnalysis extends Product {
  variants: (Variant & { analysis?: Analysis })[];
}

export interface DashboardMetrics {
  totalProducts: number;
  totalVariants: number;
  avgMargin: number | null;
  analyzedCount: number;
  pendingUpdates: number;
  negativeMargins: number;
  belowFloor: number;
  missingCosts: number;
}
