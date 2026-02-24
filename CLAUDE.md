# CLAUDE.md — Oil Slick Pad Pricing Suite

## Quick Reference

```bash
npm install          # Install dependencies
npm run dev          # Start dev server (localhost:3000)
npm run build        # Production build
npm run lint         # ESLint
```

## Project Overview

AI-powered dynamic pricing optimization for "Oil Slick Pad" Shopify smoke shop. Analyzes products, researches competitor prices, and suggests optimal pricing using smart multi-model AI routing for minimum cost with maximum quality.

## Tech Stack

- **Framework**: Next.js 14 (App Router) + React 18 + TypeScript 5.5 (strict)
- **Styling**: Tailwind CSS 3.4
- **Database**: Supabase (PostgreSQL with RLS)
- **AI Providers**: Smart multi-model routing (all via raw fetch, no SDK):
  - **Classify**: GPT-4.1 nano ($0.02/$0.15/MTok) — product identification
  - **Vision**: Gemini 2.5 Flash ($0.30/$2.50/MTok) — product image analysis
  - **Search**: Gemini 2.5 Flash + Google Search grounding (free 500/day)
  - **Analyze**: GPT-4.1 mini ($0.40/$1.60/MTok) — core pricing reasoning
  - **Deliberate**: GPT-4.1 mini — deep price validation
  - **Reflect**: GPT-4.1 nano — query regeneration
  - **Override**: `--provider claude|gemini` forces single-provider mode
- **Search**: Gemini Google Search (default, free tier), OpenAI web search, Brave Search, Amazon lookup
- **Cost Tracking**: Per-analysis and per-batch cost estimation with legacy comparison
- **Deployment**: Vercel (serverless, 300s timeout)
- **Scripts Runtime**: tsx 4.21 with separate tsconfig (`tsconfig.scripts.json`)
- **Path Alias**: `@/*` → `./src/*`

## Project Structure

```
src/
├── app/
│   ├── layout.tsx                    # Root layout with sidebar
│   ├── page.tsx                      # Dashboard
│   ├── products/page.tsx             # Product management + batch analysis
│   ├── settings/page.tsx             # Configuration
│   └── api/
│       ├── analysis/                 # AI analysis endpoints
│       ├── shopify/                  # Sync, update, test endpoints
│       ├── batch/                    # Batch create/status/process/apply/cancel
│       ├── dashboard/                # Dashboard stats
│       ├── settings/                 # Settings CRUD
│       └── test-connections/         # Connection health checks
├── components/
│   ├── ProductsContent.tsx           # Main product table with bulk analysis
│   ├── ProductModal.tsx              # Variant detail view with analysis
│   ├── Sidebar.tsx                   # Navigation sidebar
│   └── Toast.tsx                     # Notification toasts
├── lib/
│   ├── pricing-engine.ts             # Core 5-step pricing pipeline (identify→visual→search→analyze→deliberate)
│   ├── model-router.ts               # Smart model routing — cheapest model per pipeline step
│   ├── cost-tracker.ts               # Per-analysis + per-batch cost estimation with legacy comparison
│   ├── pricing-strategies.ts         # 5 expert pricing algorithms
│   ├── local-competitor-data.ts      # Curated vendor-tagged competitor database
│   ├── openai.ts                     # GPT-4.1 nano/mini/GPT-5.2 client (raw fetch)
│   ├── claude.ts                     # Claude Sonnet 4.5 / Haiku 4.5 client (raw fetch)
│   ├── gemini.ts                     # Gemini 2.5-Flash client + visual analysis (raw fetch)
│   ├── openai-search.ts             # OpenAI Responses API web search
│   ├── competitors.ts                # Brave Search competitor research
│   ├── brave.ts                      # Brave Search API wrapper
│   ├── shopify.ts                    # Shopify GraphQL sync + REST price update
│   ├── supabase.ts                   # Database client factory (anon + service role)
│   ├── rate-limiter.ts               # Concurrent semaphore rate limiter
│   ├── search-cache.ts               # In-memory search cache (15min TTL)
│   ├── batch-analyzer.ts             # Batch processing logic
│   └── volume-pricing.ts             # Power-law volume discount formula
└── types/
    └── index.ts                      # All TypeScript interfaces

scripts/
├── batch-analyze.ts                  # Standalone batch runner (GitHub Actions)
├── sync-oil-slick-pricing.ts         # CSV-based price sync
└── revert-prices.ts                  # Revert prices from recent batch runs

supabase/migrations/
├── 001_initial_schema.sql            # Core tables (products, variants, analyses, settings)
├── 002_analysis_queue.sql            # Analysis job queue
├── 003_add_ai_unrestricted.sql       # AI freedom mode + secure settings view
├── 004_batch_jobs.sql                # Persistent batch job tracking
├── 005_add_previous_price.sql        # Price history for reverts
└── 006_add_volume_pricing.sql        # Volume pricing metadata

.github/workflows/
├── batch-analyze.yml                 # Manual batch analysis (2h timeout)
├── sync-oil-slick-pricing.yml        # CSV price sync
└── revert-prices.yml                 # Price reversion
```

## Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# Shopify (scopes: read_products, write_products, read_inventory)
SHOPIFY_STORE_NAME=oil-slick-pad
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx

# AI Providers (both required for smart routing)
OPENAI_API_KEY=sk-xxxxx               # Required: GPT-4.1 nano/mini for reasoning
GOOGLE_API_KEY=AIzaxxxxx              # Required: Gemini for search + visual analysis
ANTHROPIC_API_KEY=sk-ant-xxxxx        # Optional: Only if using --provider claude

# Search
BRAVE_API_KEY=BSAxxxxx                # Optional: Only if using --search-mode brave
```

## Rate Limiters (src/lib/rate-limiter.ts)

All external APIs use singleton `ConcurrentRateLimiter` instances (semaphore + sliding window):

| Service  | Max Concurrent | Max/Min | Notes |
|----------|---------------|---------|-------|
| OpenAI   | 150           | 500     | High throughput, long-running requests |
| Shopify  | 20            | 80      | REST API bucket rate limiting |
| Brave    | 5             | 15      | Free tier is limited |
| Claude   | 15            | 40      | Output token limits are strict |
| Gemini   | 30            | 100     | Conservative defaults |

Rate limiters are per-process singletons. Do NOT launch multiple concurrent `/api/batch/process` requests.

## Smart Model Routing (src/lib/model-router.ts)

Each pipeline step routes to the cheapest capable model automatically:

| Step       | Default Model        | Fast Model      | Cost/MTok (in/out) | Why |
|------------|---------------------|-----------------|--------------------|----|
| Identify   | GPT-4.1 nano        | GPT-4.1 nano    | $0.02 / $0.15     | Simple classification |
| Visual     | Gemini 2.5 Flash    | Gemini 2.5 Flash| $0.30 / $2.50     | Best vision/cost |
| Search     | Gemini 2.5 Flash    | Gemini 2.5 Flash| Free (500/day)     | Google Search grounding |
| Analyze    | GPT-4.1 mini        | GPT-4.1 nano    | $0.40 / $1.60     | Core reasoning |
| Deliberate | GPT-4.1 mini        | GPT-4.1 nano    | $0.40 / $1.60     | Deep reasoning |
| Reflect    | GPT-4.1 nano        | GPT-4.1 nano    | $0.02 / $0.15     | Query generation |

**Estimated cost per product**: ~$0.01-$0.03 (down from ~$0.10-$0.25 with GPT-5.2)
**1,000-product batch**: ~$15-30 (down from ~$100-250)

Override with `--provider claude|gemini` to force a single provider for all steps.

## Cost Tracking (src/lib/cost-tracker.ts)

Every API call is tracked with estimated token counts and costs. Reports include:
- Per-step cost breakdown (identify, visual, search, analyze, deliberate, reflect)
- Per-provider cost breakdown (openai, gemini, claude)
- Legacy cost comparison (what it would have cost with GPT-5.2 for everything)
- Savings percentage

Cost summaries are returned in API responses and printed in batch script output.

## Batch Processing Scripts

```bash
# GitHub Actions or local — smart routing (default, cheapest)
npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
  --vendor "Vendor Name" \
  --status active \
  --concurrency 100 \
  --search-mode gemini \       # gemini (default) | openai | amazon | brave | none
  --skip-analyzed \
  --fast \                     # Use cheapest models (gpt-4.1-nano, haiku, gemini-2.5-flash)
  --dry-run

# Force single provider (all steps use that provider)
npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
  --provider claude \           # openai | claude | gemini
  --search-mode gemini

# Sync prices from CSV
npx tsx --tsconfig tsconfig.scripts.json scripts/sync-oil-slick-pricing.ts --dry-run

# Revert recent batch prices
npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts --runs 3 --dry-run
```

## Local Competitor Database (src/lib/local-competitor-data.ts)

Curated from vendor-tagged competitor analysis spreadsheets. This is the FIRST-PASS data source — checked BEFORE any external search APIs.

**Source files** (in repo root):
- `OilSlick_Vendor_Tagged_Competitors.xlsx` — 36 competitors for Oil Slick vendor products
- `WYN_Vendor_Tagged_Competitors_FINAL (1).xlsx` — 65+ competitors for Cloud YHS/WYN vendor products

**How it works:**
1. Before web search, `getKnownPriceBenchmarks()` checks if any curated price data matches the product
2. `buildSearchInstruction()` generates vendor-specific priority site lists injected into all AI search prompts
3. `getAllCompetitorDomains()` expands the `RETAIL_SMOKE_SHOPS` arrays across all search modules
4. After web search completes, local benchmarks are merged in (prepended, highest confidence)

**Oil Slick categories**: glass jars, FEP/PTFE, silicone pads, mylar bags, pre-roll tubes, syringes, parchment, custom packaging

**WYN/Cloud YHS brands**: Lookah, Smyle Labs, Cookies Glass, Monark Glass, Encore Glass, Maven Torches, RAW, Blazy Susan, Zig-Zag, Vibes, OCB, Clipper, aLeaf

**Known price benchmarks**: ~55 product-level price points (Lookah electronics, Smyle Labs, Cookies Glass, Monark, Encore, Maven, rolling papers) with competitor domain + price

**Key competitors by threat level**:

| Vendor   | HIGH Threat                                                              |
|----------|--------------------------------------------------------------------------|
| Oil Slick | 420packaging.com, cannaline.com, 420stock.com, mjwholesale.com, dragonchewer.com, gamutpackaging.com |
| WYN      | elementvape.com, dankgeek.com, smokecartel.com, aqualabtechnologies.com, boomheadshop.com, dankstop.com |

## Key Architecture Decisions

1. **Smart model routing** — Each pipeline step uses the cheapest capable model. GPT-4.1 nano for classification, Gemini 2.5 Flash for vision + search, GPT-4.1 mini for reasoning. ~6-10x cheaper than using GPT-5.2 for everything.
2. **Visual product analysis** — Gemini 2.5 Flash analyzes product images to detect quality tier (import/domestic/heady), materials, craftsmanship, and brand signals. Visual analysis overrides text-based identity when they disagree.
3. **Cost tracking** — Every API call is estimated and compared to legacy (GPT-5.2) costs. Batch reports show total cost, cost per product, and savings percentage.
4. **No SDK dependencies for AI** — All AI providers use raw `fetch()` calls, not official SDKs. The `openai` npm package is NOT installed.
5. **Shopify dual protocol** — Product sync uses GraphQL; price updates use REST API. REST is being deprecated by Shopify.
6. **Server-side only** — All external API calls run server-side via Next.js API routes (no CORS).
7. **Service role separation** — Server routes use Supabase service role key (bypasses RLS).
8. **Database-backed batches** — Batch jobs persist in `batch_jobs` table, survive page refresh/crash.
9. **Volume pricing formula** — `price = base_price × (qty / base_qty) ^ exponent` where exponent defaults to 0.92.
10. **Gross margin formula** — All calculations use `(price - cost) / price`, NOT markup `(price - cost) / cost`.
11. **Local-first competitor search** — Curated vendor-tagged competitor data is checked BEFORE external search APIs. Known price benchmarks are injected with highest confidence weight.

## No Tests

The project has no unit or integration tests. `/api/test-connections` provides runtime connectivity checks only.

## Common Gotchas

- The `claude.md` (lowercase) file is project documentation, not this Claude Code context file.
- Supabase default limit is 1000 rows — all queries must paginate.
- Vercel has 300s timeout — large batch analysis must use GitHub Actions (6h timeout).
- Rate limiter singletons are per-serverless-invocation — batch chunks must process within a single invocation.
- `compare_at_price` is the MSRP/strikethrough price, not the selling price.
