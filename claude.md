# Oil Slick Pad - AI-Powered Dynamic Pricing Suite

## Overview

This is an enterprise-grade AI-powered dynamic pricing optimization system for "Oil Slick Pad", a Shopify smoke shop. The application automatically analyzes products, researches competitor prices, and suggests optimal pricing using GPT-5.2 with advanced reasoning capabilities.

## Tech Stack

- **Frontend**: Next.js 14 (App Router) + React 18 + Tailwind CSS 3.4
- **Backend**: Next.js API Routes (server-side, no CORS)
- **Database**: Supabase (PostgreSQL with RLS)
- **AI**: OpenAI GPT-5.2 with reasoning (raw fetch, no SDK)
- **Search**: Brave Search API for competitor price discovery
- **Deployment**: Vercel (serverless, 5-min timeout for analysis)

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
- AI Unrestricted Mode for pure expert recommendation without guardrails

### 4. Deep Deliberation Fallback
When insufficient competitor data is found:
- AI reflection generates new search queries
- Visual analysis of product images
- Cost-based markup calculations (tier-specific)
- Category norms evaluation
- Uses maximum reasoning effort for best results

### 5. Smart Batch Processing (Legacy - Dashboard)
- Groups products by vendor + product type
- Priority scoring based on revenue impact
- Respects API rate limits (Brave: 0.5 req/sec, OpenAI: 5 req/sec)
- Processes highest-priority items first

### 6. Persistent Batch Analysis (Products Page - Primary)
- **Database-backed batch jobs** that survive page refreshes, browser crashes, and deployments
- Select any number of products (even thousands) and process in configurable chunks (10-200)
- **Concurrent processing**: Analyzes N variants simultaneously within each chunk (configurable 1-10, default 3)
- Auto-resume on page load: if a batch was running when the page refreshed, it picks up where it left off
- **Auto-Apply mode**: AI analyzes and immediately updates prices on Shopify, no manual review
- **AI Unlimited mode**: removes all pricing guardrails (margin floors, MSRP limits, change caps)
- **Full Autopilot**: combine both modes to let AI decide and apply all prices autonomously
- Progress saved periodically during concurrent processing, so minimal work is lost on crash
- Cancel at any time with all progress preserved
- After batch completes, "Apply All Suggestions" button bulk-applies to Shopify
- Configuration modal with chunk size slider, AI Unlimited checkbox, Auto-Apply checkbox

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Next.js Frontend                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  Dashboard  │  │  Products   │  │  Settings               │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API Routes Layer                            │
│  /api/analysis/analyze  │  /api/shopify/sync  │  /api/dashboard │
│  /api/analysis/batch    │  /api/shopify/update-price            │
│  /api/analysis/worker   │  /api/shopify/test                    │
│  /api/analysis/accept   │  /api/settings                        │
│  /api/batch (create/status) │  /api/batch/process               │
│  /api/batch/apply       │  /api/batch/cancel                    │
│  /api/test-connections                                          │
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
│  │ pricing-strategies│  │     brave     │  │  rate-limiter   │ │
│  │ (Expert Algos)    │  │  (Search API) │  │  (API Throttle) │ │
│  └───────────────────┘  └───────────────┘  └─────────────────┘ │
│  ┌───────────────────┐  ┌───────────────┐  ┌─────────────────┐ │
│  │     openai        │  │  search-cache │  │  batch-analyzer │ │
│  │  (GPT Client)     │  │  (Caching)    │  │  (Queue Mgmt)   │ │
│  └───────────────────┘  └───────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Supabase                                  │
│  products │ variants │ analyses │ settings │ analysis_queue    │
│  search_cache │ group_research │ activity_log                   │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/pricing-engine.ts` | Core 4-step pricing algorithm |
| `src/lib/pricing-strategies.ts` | Expert pricing algorithms (5 strategies) |
| `src/lib/competitors.ts` | Competitor research with Brave Search |
| `src/lib/openai.ts` | GPT-5.2 client wrapper (raw fetch, not SDK) |
| `src/lib/batch-analyzer.ts` | Smart batch processing with grouping |
| `src/lib/shopify.ts` | Shopify GraphQL API client + REST price update |
| `src/lib/brave.ts` | Brave Search API wrapper |
| `src/lib/rate-limiter.ts` | Rate limiting with exponential backoff |
| `src/lib/search-cache.ts` | Search result caching |
| `src/lib/supabase.ts` | Database client (anon + service role) |
| `src/types/index.ts` | All TypeScript interfaces |
| `src/components/ProductsContent.tsx` | Main product table with bulk analysis |
| `src/components/ProductModal.tsx` | Detailed variant view with analysis |
| `scripts/batch-analyze.ts` | Standalone batch runner for GitHub Actions |
| `.github/workflows/batch-analyze.yml` | GitHub Actions workflow for batch processing |

## Configuration (Settings)

```typescript
{
  min_margin: 20,           // Minimum gross margin % — formula: (price-cost)/price
  min_margin_dollars: 3,    // Minimum $ profit per unit
  clearance_margin: 5,      // Lower margin floor for clearance items
  max_above: 5,             // Max % above highest competitor
  max_increase: 10,         // Max price increase %
  max_decrease: 15,         // Max price decrease %
  respect_msrp: true,       // Never exceed compare_at_price
  rounding_style: 'psychological' | 'clean' | 'none',
  openai_model: 'gpt-5.2',
  product_niche: 'heady glass, dab tools, concentrate accessories',
  concurrency: 3,           // Parallel operations (1-10)
  ai_unrestricted: false,   // Bypass all pricing guardrails
}
```

## Database Schema

- **products** - Synced Shopify product catalog
- **variants** - Individual SKUs with price/cost/MSRP
- **analyses** - Pricing analysis results (one per variant, unique on variant_id)
- **settings** - Configuration and business rules (single row)
- **analysis_queue** - Batch job queue with priority
- **search_cache** - Cached competitor search results (keyed by product_type+vendor)
- **group_research** - Shared research per vendor:productType group (24h TTL)
- **activity_log** - Audit trail of all actions

### Migrations
- `001_initial_schema.sql` - Core tables, indexes, RLS, triggers
- `002_analysis_queue.sql` - Batch processing tables
- `003_add_ai_unrestricted_and_fix_rls.sql` - ai_unrestricted column, secure settings view
- `004_batch_jobs.sql` - Persistent batch job table for crash-safe batch analysis

## Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Shopify
SHOPIFY_STORE_NAME=oil-slick-pad
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx

# OpenAI
OPENAI_API_KEY=sk-xxxxx

# Brave Search
BRAVE_API_KEY=BSAxxxxx
```

## Getting Started

1. Set environment variables (see above)
2. Run database migrations in Supabase SQL Editor (001, 002, 003 in order)
3. Run the development server: `npm run dev`
4. Sync products from Shopify via the dashboard
5. Configure pricing rules in Settings
6. Run analysis on individual products or batch analyze all

## Known Issues & History

### Issues Fixed (Codebase Review - Feb 2026)

1. **CRITICAL: Margin vs Markup Formula Mismatch** - The pricing engine and strategies were using markup formula `(price-cost)/cost` while the dashboard and product table displayed gross margin `(price-cost)/price`. All calculations now consistently use gross margin. The min_margin floor formula was also fixed from `cost * (1 + margin/100)` (markup) to `cost / (1 - margin/100)` (gross margin).

2. **Worker Fallback Invalid Rounding Style** - `worker/route.ts` had `rounding_style: 'x.99'` in its fallback settings, which is not a valid option. Fixed to `'psychological'`.

3. **Unused Dependencies** - Removed `openai` npm package from dependencies (code uses raw `fetch` calls, not the SDK). Removed unused `WHOLESALE_DOMAINS_SHORT` constant from `pricing-engine.ts`.

4. **Missing CSS Animation** - Toast component used `animate-fade-in` class but the keyframe was never defined in `globals.css`. Added the missing animation.

5. **Settings dbWarning Never Displayed** - The `dbWarning` state was declared and set but never rendered in the JSX. Now displays a yellow warning banner when the `ai_unrestricted` column is missing from the database.

6. **React Hook Dependency Warning** - Dashboard `loadDashboard` function was not wrapped in `useCallback`, causing React to warn about missing dependencies in `useEffect`. Fixed.

7. **Concurrency UI Mismatch** - Settings page showed a slider max of 30 but the bulk analysis code capped at 5. Aligned both to 1-10 range.

8. **Shopify Test Route Inconsistent Response** - `/api/shopify/test` returned a response without `success: true/false` when env vars were missing, unlike all other routes. Fixed for consistency.

9. **below_floor Filter Hardcoded** - Product filter for "Below Floor" was hardcoded to 20% instead of using the user's `settings.min_margin` value. Fixed.

10. **Database Schema Missing ai_unrestricted** - Added migration 003 to add the `ai_unrestricted` column to settings and create a secure view that excludes API key columns.

11. **Persistent Batch System** - Replaced in-memory batch processing with a database-backed system. New `batch_jobs` table stores all batch state (variant IDs, progress, settings). Processing automatically resumes after page refreshes. Added auto-apply mode, AI unlimited mode, configurable chunk sizes, and bulk apply for completed batches.

12. **Concurrent Batch Processing & Rate Limiting** - Batch processing was sequential (one variant at a time). Now processes N variants concurrently within each chunk using a worker-pool pattern. OpenAI calls were not rate-limited (raw fetch without throttling) — now routed through `openaiRateLimiter`. Shopify price updates had no rate limiting — now routed through new `shopifyRateLimiter` (2 req/sec, 80/min). Brave was already rate-limited via `braveRateLimiter` in `competitors.ts`. Concurrency is controlled by the `settings.concurrency` value (1-10, default 3). With concurrency=3, analyses overlap their I/O waits (while one waits for Brave, another runs OpenAI), giving ~2-3x throughput improvement without exceeding any API limits.

### Previous Issues (Resolved in Earlier Sessions)

- **Large Catalog Support** - Supabase default limit is 1000 rows. Added pagination for products, variants, and analyses to support stores with 1000+ products.
- **Settings Persistence** - `ai_unrestricted` setting is persisted to both localStorage (immediate) and database (when column exists) for reliability.
- **Analysis Timeout** - Increased to 300 seconds for complex pricing analysis on Vercel.
- **Batch Analysis Progress** - Added visual progress bar with shimmer animation, cancel button, and per-item tracking.

### Architecture Considerations

- **Shopify API Dual Protocol**: Product sync uses GraphQL, but price updates use REST API. The REST Admin API is being phased out by Shopify — future work should migrate `updateVariantPrice` to use GraphQL `productVariantUpdate` mutation.
- **No Error Boundary**: The React app has no error boundary component. A runtime error in any component will crash the entire app.
- **No Activity Log Cleanup**: The `activity_log` table grows indefinitely. Consider adding a cron job or cleanup function.
- **RLS Policy Breadth**: The migration 003 creates a secure view for settings, but the existing RLS policies still allow anon SELECT on the full settings table. For production, consider restricting anon access to the view only.
- **No Tests**: The project has no unit or integration tests. The `/api/test-connections` endpoint provides runtime connectivity checks but no automated testing.

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

### Pricing Strategies (pricing-strategies.ts)
1. **Competitor Intelligence** - Weighted analysis of known retailers vs unknown sources
2. **Psychological Pricing** - .99 endings, threshold avoidance, left-digit effect
3. **Profit Optimization** - Tier-specific markup ranges (2-10x cost)
4. **Market Positioning** - Value-leader, competitive, premium, luxury
5. **Price Anchoring** - Strategic MSRP/compare-at pricing

### Rate Limiting & Concurrency
All external API calls are routed through singleton rate limiters with exponential backoff:
- **Brave Search**: 0.5 req/sec, 15/min — routed through `braveRateLimiter` in `competitors.ts`
- **OpenAI GPT-5.2**: 5 req/sec, 200/min — routed through `openaiRateLimiter` in `openai.ts`
- **Shopify REST**: 2 req/sec, 80/min — routed through `shopifyRateLimiter` in `shopify.ts`
- **Supabase**: No explicit rate limiting needed (~100 req/sec connection pool)

Concurrent batch processing uses a worker-pool pattern (`runWithConcurrency`) where N workers pull from a shared task queue. The rate limiters automatically serialize requests that would exceed API limits, so concurrent analyses safely overlap their I/O waits (e.g., while analysis A waits for Brave, analysis B runs its OpenAI step).

**Important**: Rate limiter singletons are per-serverless-invocation. The system processes chunks within a single invocation to ensure rate limits are shared. Do NOT launch multiple concurrent `/api/batch/process` requests for the same batch.

### Per-Analysis API Call Breakdown
| Step | API | Calls | Notes |
|------|-----|-------|-------|
| identifyProduct | OpenAI | 1 | reasoning: high |
| searchCompetitors | Brave | 3-30 | 3 broadening levels, up to 10 queries each |
| extractPriceFromPage | HTTP | 0-8 | Direct fetch to retailer pages |
| analyzePricing | OpenAI | 1 | reasoning: high |
| reflectAndRetry | OpenAI+Brave | 0-11 | Only if <2 competitors found |
| deliberatePricing | OpenAI | 0-1 | reasoning: xhigh, only if low confidence |
| saveAnalysis | Supabase | 2 | DELETE + INSERT |
| auto-apply | Shopify REST | 0-1 | Only if auto_apply enabled |

Typical: 2-3 OpenAI + 5-15 Brave + 2 Supabase per analysis
Brave is the primary bottleneck (0.5 req/sec vs OpenAI's 5 req/sec)

### Error Handling
- Graceful degradation on search failures
- Deliberation fallback for insufficient data
- Comprehensive activity logging

### GitHub Actions Batch Processing

The Vercel deployment has a 300s serverless timeout which is too short for batch analysis (each analysis takes 30-90s due to Brave rate limiting). For large batches, use the **GitHub Actions workflow** which has a 6-hour timeout and runs as a single long-lived process (rate limiter singletons work properly).

**Workflow:** `.github/workflows/batch-analyze.yml`
**Script:** `scripts/batch-analyze.ts`
**Tsconfig:** `tsconfig.scripts.json` (separate from Next.js build)

#### How to Run

1. Go to GitHub repo → Actions → "Batch Price Analysis"
2. Click "Run workflow"
3. Configure inputs:
   - **Vendor**: Filter by vendor name (empty = all vendors)
   - **Status**: `active`, `draft`, or `all`
   - **Concurrency**: 1-5 parallel analyses (default 2)
   - **Limit**: Max variants to process (0 = unlimited)
   - **Dry run**: Analyze without applying prices
4. Click "Run workflow"

#### Required GitHub Secrets

Set these in repo Settings → Secrets and variables → Actions:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `BRAVE_API_KEY`
- `SHOPIFY_STORE_NAME`
- `SHOPIFY_ACCESS_TOKEN`

#### Features
- **AI Unlimited Mode**: Always enabled — no margin floors, MSRP limits, or change caps
- **Auto-Apply**: Prices are applied to Shopify immediately after analysis (unless `--dry-run` or `--skip-apply`)
- **Fatal Error Detection**: Stops batch on OpenAI quota/billing errors
- **Progress Logging**: Console output shows per-variant progress with timestamps
- **Activity Log**: Start and finish logged to Supabase `activity_log` table
- **Pagination**: Handles stores with 1000+ products via Supabase pagination
- **Configurable Concurrency**: Worker pool pattern processes N variants in parallel

#### Running Locally

```bash
# Set env vars in .env.local or export them
npm run batch-analyze -- --vendor "Artist Name" --status active --concurrency 2

# Dry run (no price changes)
npm run batch-analyze -- --status active --dry-run

# Process first 10 variants only
npm run batch-analyze -- --vendor "Some Brand" --limit 10
```

---

*Built with Next.js 14, OpenAI GPT-5.2, and Supabase*
