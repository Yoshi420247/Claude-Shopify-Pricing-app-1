# Oil Slick Pad Pricing Suite

AI-powered dynamic pricing optimization for Shopify, built with Next.js, Supabase, and GPT-5.2.

## Architecture

- **Frontend**: Next.js 14 (App Router) + Tailwind CSS
- **Backend**: Next.js API Routes (server-side, zero CORS issues)
- **Database**: Supabase (PostgreSQL) for products, variants, analyses, settings
- **AI**: OpenAI GPT-5.2 with reasoning for product identification and pricing analysis
- **Search**: Brave Search API for competitor price discovery
- **Deployment**: Vercel

## Setup

### 1. Supabase Database

1. Create a project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run `supabase/migrations/001_initial_schema.sql`
3. Copy your project URL, anon key, and service role key

### 2. Environment Variables

Create `.env.local` (see `.env.local.example`):

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SHOPIFY_STORE_NAME=oil-slick-pad
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx
OPENAI_API_KEY=sk-xxxxx
BRAVE_API_KEY=BSAxxxxx
```

### 3. Shopify App Permissions

Your Shopify access token needs these scopes:
- `read_products` — fetch product catalog
- `write_products` — update prices
- `read_inventory` — read cost data

### 4. Run Locally

```bash
npm install
npm run dev
```

### 5. Deploy to Vercel

1. Push to GitHub
2. Import in Vercel
3. Add all environment variables in Vercel project settings
4. Deploy

## Usage

1. **Dashboard** — Sync products from Shopify, see metrics
2. **Products** — View all variants, run AI analysis, review/accept suggestions
3. **Settings** — Configure pricing rules, AI model, store context

## Key Improvements over Prototype

| Feature | Prototype | Production |
|---|---|---|
| Storage | localStorage | Supabase PostgreSQL |
| API calls | Client-side + CORS proxies | Server-side (zero CORS) |
| AI model | GPT-4o | GPT-5.2 with reasoning |
| Variants | Only first variant | All variants individually |
| Deployment | Static file | Vercel (auto-scaling) |
| Data persistence | Browser-only | Cloud database |
| Catalog size | ~100 products | Full catalog (paginated GraphQL) |
