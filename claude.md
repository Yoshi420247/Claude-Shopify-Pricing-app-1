# Oil Slick Pad - AI-Powered Dynamic Pricing Suite

## Overview

This is an enterprise-grade AI-powered dynamic pricing optimization system for "Oil Slick Pad", a Shopify smoke shop. The application automatically analyzes products, researches competitor prices, and suggests optimal pricing using GPT-5.2 with advanced reasoning capabilities.

## Tech Stack

- **Frontend**: Next.js 14 (App Router) + React + Tailwind CSS
- **Backend**: Next.js API Routes (server-side)
- **Database**: Supabase (PostgreSQL)
- **AI**: OpenAI GPT-5.2 with reasoning
- **Search**: Brave Search API for competitor price discovery
- **Deployment**: Vercel

## Core Features

### 1. AI Product Identification
Uses GPT-5.2 with vision to analyze product images and metadata, classifying products into three quality tiers:
- **Import**: China/overseas mass-produced ($5-50, generic)
- **Domestic**: USA/American-made quality ($30-200+)
- **Heady**: Handmade artisan/art glass ($100-1000+, artist-made)

### 2. Intelligent Competitor Research
- Multi-attempt search strategy with progressive broadening (3 levels)
- Brave Search API with automatic wholesale domain filtering
- Price extraction from multiple sources (schema.org, og:price, HTML patterns)
- Curated list of 26+ known retail smoke shops for priority matching
- Smart caching to avoid redundant API calls

### 3. Advanced AI Pricing Analysis
- GPT-5.2 analyzes competitor data with configurable constraints
- Minimum margin enforcement (percentage or dollar amount)
- MSRP respect option
- Price change limits (max increase/decrease percentages)
- Psychological rounding options (.99, clean, or none)

### 4. Deep Deliberation Fallback
When insufficient competitor data is found:
- AI reflection generates new search queries
- Visual analysis of product images
- Cost-based markup calculations (tier-specific)
- Category norms evaluation
- Uses maximum reasoning effort for best results

### 5. Smart Batch Processing
- Groups products by vendor + product type
- Priority scoring based on revenue impact
- Respects API rate limits (Brave: 0.5 req/sec, OpenAI: 5 req/sec)
- Processes highest-priority items first

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Next.js Frontend                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  Dashboard  │  │  Products   │  │  Analysis Results       │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API Routes Layer                            │
│  /api/analysis/analyze  │  /api/shopify/sync  │  /api/dashboard │
│  /api/analysis/batch    │  /api/shopify/update-price            │
│  /api/analysis/worker   │  /api/settings                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Core Library Layer                           │
│  ┌───────────────────┐  ┌───────────────┐  ┌─────────────────┐ │
│  │  pricing-engine   │  │  competitors  │  │    shopify      │ │
│  │  (AI Pipeline)    │  │  (Web Search) │  │  (GraphQL API)  │ │
│  └───────────────────┘  └───────────────┘  └─────────────────┘ │
│  ┌───────────────────┐  ┌───────────────┐  ┌─────────────────┐ │
│  │     openai        │  │     brave     │  │  rate-limiter   │ │
│  │  (GPT-5.2 Client) │  │  (Search API) │  │  (API Throttle) │ │
│  └───────────────────┘  └───────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Supabase                                  │
│  products │ variants │ analyses │ settings │ analysis_queue    │
│  search_cache │ activity_log                                    │
└─────────────────────────────────────────────────────────────────┘
```

## Pricing Pipeline Flow

```
User Action: "Analyze Product" or "Batch Analyze All"
    │
    ▼
┌─────────────────────────────────────────┐
│  Step 1: PRODUCT IDENTIFICATION         │
│  - Fetch product data from Supabase     │
│  - GPT-5.2 + product image analysis     │
│  - Returns: tier, features, confidence  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  Step 2: COMPETITOR SEARCH              │
│  - Level 0: Specific product queries    │
│  - Level 1: Generic category queries    │
│  - Level 2: Broad category queries      │
│  - Extract prices from snippets & pages │
│  - Stop when 2+ competitors found       │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  Step 3: AI PRICING ANALYSIS            │
│  - Analyze competitor price distribution│
│  - Apply business constraints           │
│  - Calculate optimal price              │
│  - Determine market position            │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  Step 4: CONFIDENCE CHECK               │
│  - If <2 competitors: AI reflection     │
│  - Retry with new search queries        │
│  - If still insufficient: deliberation  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  Step 5: CONSTRAINTS APPLIED            │
│  - Min margin (20% or $3)               │
│  - MSRP ceiling (optional)              │
│  - Max above competitor (+5%)           │
│  - Change limits (±10-15%)              │
│  - Rounding style applied               │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  Step 6: STORAGE & DISPLAY              │
│  - Save to analyses table               │
│  - Log activity                         │
│  - Return results to UI                 │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  Step 7: USER REVIEW & APPROVAL         │
│  - User reviews suggested price         │
│  - If accepted: Update Shopify          │
│  - Mark as applied                      │
└─────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/pricing-engine.ts` | Core 4-step pricing algorithm |
| `src/lib/competitors.ts` | Competitor research with Brave Search |
| `src/lib/openai.ts` | GPT-5.2 client wrapper |
| `src/lib/batch-analyzer.ts` | Smart batch processing |
| `src/lib/shopify.ts` | Shopify GraphQL API client |
| `src/lib/brave.ts` | Brave Search API wrapper |
| `src/lib/rate-limiter.ts` | Rate limiting with exponential backoff |
| `src/lib/search-cache.ts` | Search result caching |
| `src/lib/supabase.ts` | Database client |

## Configuration (Settings)

```typescript
{
  min_margin: 20,           // Minimum % margin
  min_margin_dollars: 3,    // Minimum $ margin
  max_above: 5,             // Max % above highest competitor
  max_increase: 10,         // Max price increase %
  max_decrease: 15,         // Max price decrease %
  respect_msrp: true,       // Never exceed compare_at_price
  rounding_style: 'psychological' | 'clean' | 'none',
  openai_model: 'gpt-5.2',
  product_niche: 'heady glass, dab tools, concentrate accessories'
}
```

## Database Schema

- **products** - Synced Shopify product catalog
- **variants** - Individual SKUs with price/cost/MSRP
- **analyses** - Pricing analysis results (one per variant)
- **settings** - Configuration and business rules
- **analysis_queue** - Batch job queue with priority
- **search_cache** - Cached competitor search results
- **activity_log** - Audit trail of all actions

## Getting Started

1. Set environment variables:
   - `OPENAI_API_KEY`
   - `BRAVE_API_KEY`
   - `SHOPIFY_STORE_URL`
   - `SHOPIFY_ACCESS_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`

2. Run the development server:
   ```bash
   npm run dev
   ```

3. Sync products from Shopify via the dashboard

4. Configure pricing rules in Settings

5. Run analysis on individual products or batch analyze all

## Advanced Features

### Batch Priority Scoring
```
Base: 50
+ 30: No existing analysis
+ 20: Active product status
+ 15/10/5: Higher price (revenue impact)
+ 25: Negative margin (losing money)
- 10: Draft product
```

### Rate Limiting
- Brave API: 0.5 requests/second
- OpenAI API: 5 requests/second
- Automatic retry with exponential backoff

### Error Handling
- Graceful degradation on search failures
- Deliberation fallback for insufficient data
- Comprehensive activity logging

---

*Built with Next.js 14, OpenAI GPT-5.2, and Supabase*
