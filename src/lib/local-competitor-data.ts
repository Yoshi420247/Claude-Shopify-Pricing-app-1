// ============================================================================
// Local Competitor Database — curated from vendor-tagged competitor analysis
// ============================================================================
// Source files:
//   - OilSlick_Vendor_Tagged_Competitors.xlsx (Oil Slick vendor products)
//   - WYN_Vendor_Tagged_Competitors_FINAL.xlsx (Cloud YHS / What You Need products)
//
// This module provides the FIRST-PASS competitor data for pricing analysis.
// The AI search pipeline checks this data BEFORE hitting external search APIs.
// These are 99% of the competitors in the market for both vendors.
// ============================================================================

import type { CompetitorPrice, CompetitorSearchResult } from './competitors';
import type { ProductIdentity } from '@/types';

// ============================================================================
// Types
// ============================================================================

export interface VendorCompetitor {
  domain: string;
  name: string;
  threatLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  categories: string[];       // Product categories they compete in
  pricePosition?: string;     // e.g. 'aggressive-low', 'mid-market', 'premium'
  notes?: string;
}

export interface KnownPriceBenchmark {
  productPattern: RegExp;     // Pattern to match against product title
  brand?: string;             // Brand filter (if null, matches any)
  competitorDomain: string;
  competitorName: string;
  price: number;
  category: string;
  notes?: string;
}

// ============================================================================
// OIL SLICK Vendor Competitors
// ============================================================================
// Source: OilSlick_Vendor_Tagged_Competitors.xlsx
// Categories: Glass Jars, FEP/PTFE, Silicone Pads, Mylar Bags, Pre-Roll Tubes,
//             Syringes, Custom Packaging, Parchment/Rosin Paper

const OIL_SLICK_COMPETITORS: VendorCompetitor[] = [
  // HIGH THREAT
  { domain: '420packaging.com', name: '420 Packaging (Marijuana Packaging)', threatLevel: 'HIGH',
    categories: ['glass jars', 'fep', 'ptfe', 'silicone pads', 'mylar bags', 'pre-roll tubes', 'syringes', 'custom packaging', 'parchment'],
    notes: 'Vernon CA — Full-service, one of the largest in the industry, price-beat guarantee' },
  { domain: 'cannaline.com', name: 'Cannaline', threatLevel: 'HIGH',
    categories: ['glass jars', 'mylar bags', 'pre-roll tubes', 'syringes', 'custom packaging'],
    notes: 'MD — Since 2009, proprietary molds, custom printing, compound film bags' },
  { domain: '420stock.com', name: '420 Stock', threatLevel: 'HIGH',
    categories: ['glass jars', 'fep', 'ptfe', 'silicone pads', 'mylar bags', 'pre-roll tubes', 'syringes', 'custom packaging', 'parchment'],
    notes: 'Sacramento CA — Broad wholesale catalog, aggressive FEP pricing' },
  { domain: 'mjwholesale.com', name: 'MJ Wholesale', threatLevel: 'HIGH',
    categories: ['glass jars', 'fep', 'ptfe', 'silicone pads', 'mylar bags', 'pre-roll tubes', 'syringes', 'custom packaging', 'parchment'],
    notes: 'Full-line distributor, carries Oil Slick brand — buyers do side-by-side comparison' },
  { domain: 'dragonchewer.com', name: 'Dragon Chewer', threatLevel: 'HIGH',
    categories: ['glass jars', 'silicone pads', 'mylar bags', 'pre-roll tubes', 'custom packaging'],
    notes: 'CA — CR-focused, Supercell jar doubles as carb cap, strong wholesale pricing' },
  { domain: 'kushsupplyco.com', name: 'KushCo / Greenlane (Pollen Gear)', threatLevel: 'HIGH',
    categories: ['glass jars', 'mylar bags', 'pre-roll tubes', 'syringes', 'custom packaging'],
    notes: 'Public company, premium Pollen Gear brand jars, enterprise sales' },
  { domain: 'gamutpackaging.com', name: 'Gamut Packaging', threatLevel: 'HIGH',
    categories: ['glass jars', 'fep', 'mylar bags', 'pre-roll tubes', 'syringes', 'custom packaging'],
    notes: 'Vernon CA — Lift Off FEP brand (direct competing SKU), glass syringes' },

  // MEDIUM THREAT
  { domain: 'greentechpackaging.com', name: 'Green Tech Packaging', threatLevel: 'MEDIUM',
    categories: ['glass jars', 'mylar bags', 'pre-roll tubes', 'custom packaging'],
    notes: 'ASTM-certified CR glass jars, humidity packs, wooden lids' },
  { domain: 'greenrushpackaging.com', name: 'Green Rush Packaging', threatLevel: 'MEDIUM',
    categories: ['glass jars', 'mylar bags', 'pre-roll tubes', 'custom packaging'],
    notes: 'Barrier bags, CR containers, full-line' },
  { domain: 'thepressclub.co', name: 'The Press Club', threatLevel: 'MEDIUM',
    categories: ['fep', 'parchment'],
    notes: 'FEP sheets, rosin bags, bubble wash bags — owns extraction-community mindshare' },
  { domain: 'fluorolab.com', name: 'Fluorolab', threatLevel: 'MEDIUM',
    categories: ['fep'],
    notes: 'FEP sheet manufacturer, custom sizes/thicknesses' },
  { domain: 'sanapackaging.com', name: 'Sana Packaging', threatLevel: 'MEDIUM',
    categories: ['glass jars', 'pre-roll tubes', 'custom packaging'],
    notes: 'CO — Sustainable ocean plastic, glass jars, pre-roll tubes' },
  { domain: 'calyxcontainers.com', name: 'Calyx Containers', threatLevel: 'MEDIUM',
    categories: ['glass jars', 'fep', 'pre-roll tubes', 'custom packaging'],
    notes: 'Patented FEP liner, bi-injection mold lids, MVTR tested' },
  { domain: 'vsyndicate.com', name: 'V Syndicate', threatLevel: 'MEDIUM',
    categories: ['silicone pads'],
    notes: 'Slikks branded silicone dab mats with licensed art prints' },
  { domain: 'rxdco.com', name: 'RXDco', threatLevel: 'MEDIUM',
    categories: ['glass jars', 'pre-roll tubes', 'syringes', 'custom packaging'],
    notes: 'NYC — Premium CR packaging, patented designs, custom engineering' },
  { domain: 'thebureau.nyc', name: 'The Bureau', threatLevel: 'MEDIUM',
    categories: ['glass jars', 'pre-roll tubes', 'custom packaging'],
    notes: 'NYC — Airtight silicone ring jars, JONA vape' },
  { domain: 'custom420.com', name: 'Custom 420 Supply', threatLevel: 'MEDIUM',
    categories: ['glass jars', 'mylar bags', 'custom packaging'],
    notes: 'Madison CT — Custom bags, jars, labels' },
  { domain: 'thecarycompany.com', name: 'The Cary Company', threatLevel: 'MEDIUM',
    categories: ['glass jars', 'mylar bags', 'pre-roll tubes', 'custom packaging'],
    notes: 'Addison IL — Broad packaging distributor' },

  // LOW THREAT
  { domain: 'cooljarz.com', name: 'CoolJarz', threatLevel: 'LOW',
    categories: ['pre-roll tubes', 'custom packaging'],
    notes: 'Tustin CA — USA-made pre-roll tubes manufacturer' },
  { domain: 'customconesusa.com', name: 'Custom Cones USA', threatLevel: 'LOW',
    categories: ['pre-roll tubes', 'custom packaging'],
    notes: 'Pre-roll tubes, ocean plastic tubes, glass tubes' },
  { domain: 'theconesfactory.com', name: 'The Cones Factory', threatLevel: 'LOW',
    categories: ['pre-roll tubes', 'custom packaging'] },
  { domain: 'packlahoma.com', name: 'Packlahoma', threatLevel: 'LOW',
    categories: ['pre-roll tubes'],
    notes: 'OK — Price-match guarantee, pre-roll tube focus' },
  { domain: 'verticalsupplyco.com', name: 'Vertical Supply Co.', threatLevel: 'LOW',
    categories: ['glass jars'] },
  { domain: 'thesupplyjoint.com', name: 'The Supply Joint', threatLevel: 'LOW',
    categories: ['glass jars', 'silicone pads'] },
  { domain: 'bagking.com', name: 'Bag King', threatLevel: 'LOW',
    categories: ['mylar bags', 'custom packaging'] },
  { domain: 'treehuggercontainers.com', name: 'Tree Hugger Containers', threatLevel: 'LOW',
    categories: ['mylar bags', 'custom packaging'] },
  { domain: 'creativelabz843.com', name: 'Creative Labz', threatLevel: 'LOW',
    categories: ['mylar bags'] },
  { domain: 'oxopackaging.com', name: 'OXO Packaging', threatLevel: 'LOW',
    categories: ['mylar bags', 'custom packaging'] },
  { domain: 'vapepenswholesale.com', name: 'Vape Pens Wholesale', threatLevel: 'LOW',
    categories: ['syringes'] },
  { domain: 'dulytek.com', name: 'Dulytek', threatLevel: 'LOW',
    categories: ['parchment'],
    notes: 'Rosin presses + thick parchment paper' },
  { domain: 'dankgeek.com', name: 'DankGeek', threatLevel: 'LOW',
    categories: ['silicone pads'],
    notes: 'Retail dab mats, pads — consumer-facing' },
  { domain: 'smokecartel.com', name: 'Smoke Cartel', threatLevel: 'LOW',
    categories: ['silicone pads'],
    notes: 'Retail silicone pads/mats (StonerDays, DabPadz)' },
  { domain: 'bascousa.com', name: 'BascoUSA', threatLevel: 'LOW',
    categories: ['glass jars'] },
  { domain: 'roetell.com', name: 'Roetell', threatLevel: 'LOW',
    categories: ['glass jars', 'custom packaging'],
    notes: 'Chinese glass manufacturer, MOQ 3000 units' },
  { domain: 'rocketindustrial.com', name: 'Rocket Industrial', threatLevel: 'LOW',
    categories: ['glass jars', 'mylar bags', 'pre-roll tubes', 'custom packaging'] },
  { domain: 'noterdpfs.com', name: 'Noterd (PFS)', threatLevel: 'LOW',
    categories: ['syringes', 'custom packaging'],
    notes: 'Chinese glass syringe manufacturer, 16yr exp' },
];

// ============================================================================
// WYN / CLOUD YHS Vendor Competitors
// ============================================================================
// Source: WYN_Vendor_Tagged_Competitors_FINAL.xlsx
// Categories: Electronics (Lookah, Smyle), Cookies Glass, Monark Glass,
//             Encore Glass, Maven Torches, Rolling Papers, Generic Glass, etc.

const WYN_COMPETITORS: VendorCompetitor[] = [
  // TIER 1 — Highest Threat
  { domain: 'elementvape.com', name: 'Element Vape', threatLevel: 'HIGH',
    categories: ['electronics', 'lookah', 'vaporizers', '510 batteries'],
    pricePosition: 'aggressive-low',
    notes: 'BIGGEST PRICE THREAT ON ELECTRONICS. Undercuts by 40-77% on Lookah line.' },
  { domain: 'dankgeek.com', name: 'DankGeek', threatLevel: 'HIGH',
    categories: ['electronics', 'lookah', 'cookies glass', 'maven torches', 'rolling papers', 'blazy susan', 'dab rigs', 'hand pipes', 'grinders', 'quartz', 'nectar collectors'],
    pricePosition: 'mid-market',
    notes: 'Maven K2 at $44.99. Strong Cookies Glass and borosilicate selection.' },
  { domain: 'smokecartel.com', name: 'Smoke Cartel', threatLevel: 'HIGH',
    categories: ['cookies glass', 'blazy susan', 'raw', 'zig zag', 'vibes', 'glass pipes', 'dab rigs', 'bongs', 'bubblers', 'grinders'],
    pricePosition: 'mid-market',
    notes: 'Cabana Club membership offers ongoing discounts. Verified brand sourcing.' },
  { domain: 'aqualabtechnologies.com', name: 'Aqua Lab Technologies', threatLevel: 'HIGH',
    categories: ['cookies glass', 'monark glass', 'dab rigs', 'bongs', 'quartz', 'carb caps'],
    pricePosition: 'premium',
    notes: 'PRIMARY Cookies Glass authorized retailer. Full Monark line. Authenticity guaranteed.' },
  { domain: 'boomheadshop.com', name: 'Boom Headshop', threatLevel: 'HIGH',
    categories: ['cookies glass', 'smyle labs', 'lookah', 'dab rigs', 'bongs', 'vaporizers'],
    pricePosition: 'mid-market',
    notes: 'KEY: Only major third-party retailer for Smyle Labs Penjamin line. Price match guarantee.' },

  // TIER 2 — Significant Threat
  { domain: 'dankstop.com', name: 'DankStop', threatLevel: 'HIGH',
    categories: ['lookah', 'raw', 'blazy susan', 'glass bongs', 'dab rigs', 'grinders', 'hand pipes', 'vaporizers'],
    pricePosition: 'competitive',
    notes: 'Since 2014. 1M+ customers. Free shipping on all orders.' },
  { domain: 'everythingfor420.com', name: 'Everything 420', threatLevel: 'HIGH',
    categories: ['cookies glass', 'glass bongs', 'dab rigs', 'hand pipes', 'grinders'],
    pricePosition: 'competitive',
    notes: 'Since 2018. 800K+ customers. Carries Cookies glass.' },
  { domain: 'discountvapepen.com', name: 'Discount Vape Pen', threatLevel: 'HIGH',
    categories: ['electronics', 'lookah'],
    pricePosition: 'aggressive-low',
    notes: 'Seahorse Pro Plus at $32.99. Dragon Egg $72.99 Staff Pick. YouTube reviews drive traffic.' },
  { domain: 'smokeday.com', name: 'SmokeDay', threatLevel: 'MEDIUM',
    categories: ['lookah', 'dab rigs', 'glass bongs'],
    pricePosition: 'mid-market',
    notes: 'Seahorse Pro Plus at $39.99. Dragon Egg at $69.99. Discreet shipping.' },
  { domain: 'cityvaporizer.com', name: 'CityVaporizer', threatLevel: 'MEDIUM',
    categories: ['lookah', 'vaporizers'],
    pricePosition: 'aggressive-low',
    notes: 'Dragon Egg at $66.' },
  { domain: 'american420smokeshop.com', name: 'American 420 SmokeShop', threatLevel: 'HIGH',
    categories: ['lookah', 'electronics', '510 batteries'],
    pricePosition: 'competitive',
    notes: 'Extensive Lookah selection including ALL coil types and replacement parts.' },
  { domain: 'pulsarshop.com', name: 'Pulsar Shop', threatLevel: 'HIGH',
    categories: ['cookies glass', 'glass bongs', 'dab rigs', 'vaporizers', 'hand pipes', 'grinders'],
    pricePosition: 'mid-premium',
    notes: 'Official Cookies Glass retailer. Sale pricing on Cookies items.' },

  // TIER 3 — Moderate Threat
  { domain: 'grasscity.com', name: 'Grasscity', threatLevel: 'MEDIUM',
    categories: ['lookah', 'raw', 'glass bongs', 'dab rigs', 'grinders', 'rolling papers', 'vaporizers', 'nectar collectors'],
    pricePosition: 'mid-premium',
    notes: 'Founded 2000 — world\'s first online smoke shop. Global reach.' },
  { domain: 'worldofbongs.co', name: 'World of Bongs', threatLevel: 'MEDIUM',
    categories: ['lookah', 'cookies glass', 'glass bongs', 'dab rigs', 'vaporizers'],
    pricePosition: 'mid-market',
    notes: '3M+ followers. Cookies Mighty Mini at $99.' },
  { domain: 'badassglass.com', name: 'Badass Glass', threatLevel: 'MEDIUM',
    categories: ['glass bongs', 'dab rigs', 'hand pipes', 'recyclers', 'bubblers'],
    pricePosition: 'budget-mid',
    notes: 'SoCal based. Strong Diamond Glass selection. Free shipping + free returns.' },
  { domain: 'fatbuddhaglass.com', name: 'Fat Buddha Glass', threatLevel: 'MEDIUM',
    categories: ['glass bongs', 'dab rigs', 'hand pipes', 'bubblers', 'silicone'],
    pricePosition: 'budget-mid',
    notes: 'Wide affordable glass selection. Competitor on silicone pipes and budget glass.' },
  { domain: 'smokingoutlet.net', name: 'Smoking Outlet', threatLevel: 'MEDIUM',
    categories: ['lookah', 'zig zag', 'rolling papers'],
    pricePosition: 'mid-market' },
  { domain: 'caliconnected.com', name: 'CaliConnected', threatLevel: 'MEDIUM',
    categories: ['maven torches', 'lookah', 'glass bongs', 'dab rigs', 'vaporizers'],
    pricePosition: 'competitive',
    notes: 'Maven K2 carried. Price match guarantee.' },
  { domain: 'monstersmokeshops.com', name: 'Monster Smoke Shops', threatLevel: 'MEDIUM',
    categories: ['maven torches', 'cookies glass'],
    pricePosition: 'mid-market' },
  { domain: 'monarkgallery.com', name: 'Monark Gallery (DTC)', threatLevel: 'MEDIUM',
    categories: ['monark glass'],
    pricePosition: 'premium',
    notes: 'Official Monark DTC. MSRP reference. Includes quartz line, Puffco Proxy bubblers.' },
  { domain: 'smokeglassvape.com', name: 'Smoke Glass Vape', threatLevel: 'MEDIUM',
    categories: ['monark glass', 'glass bongs', 'dab rigs', 'recyclers'] },
  { domain: 'smokecityshop.com', name: 'Smoke City Shop', threatLevel: 'MEDIUM',
    categories: ['monark glass', 'glass bongs', 'dab rigs', 'recyclers'] },
  { domain: 'thesmokeshopguys.com', name: 'The Smoke Shop Guys', threatLevel: 'MEDIUM',
    categories: ['monark glass', 'glass bongs', 'dab rigs'],
    notes: 'Monark 13" Recycler at $149.99, Incycler at $149.99.' },
  { domain: 'highrollersmoke.com', name: 'High Roller Smoke', threatLevel: 'MEDIUM',
    categories: ['encore glass', 'monark glass', 'heady glass'],
    pricePosition: 'premium',
    notes: 'Carries both Encore and Monark lines. Heady glass focus.' },
  { domain: 'kcsmokeshop.com', name: 'KC Smoke Shop', threatLevel: 'MEDIUM',
    categories: ['maven torches', 'cookies glass', 'glass pipes', 'dab rigs'],
    pricePosition: 'mid-market' },
  { domain: 'artofglass.com', name: 'Art of Glass', threatLevel: 'MEDIUM',
    categories: ['clipper', 'blazy susan', 'raw', 'elements', 'maven torches', 'aleaf', 'torches', 'lighters'],
    pricePosition: 'mid-market',
    notes: 'Extensive brand list matching WYN. All major rolling paper brands.' },
  { domain: 'kings-pipe.com', name: 'King\'s Pipe', threatLevel: 'MEDIUM',
    categories: ['lookah', 'premium glass', 'santa cruz shredder'],
    pricePosition: 'mid-market',
    notes: 'Strong Lookah vaporizer section. Good replacement parts inventory.' },
  { domain: 'tokendab.com', name: 'Toke N Dab', threatLevel: 'MEDIUM',
    categories: ['aleaf', 'clipper', 'lighters', 'torches', 'glass'],
    pricePosition: 'mid-market' },

  // TIER 4 — Low Threat
  { domain: '420science.com', name: '420 Science', threatLevel: 'LOW',
    categories: ['raw', 'glass bongs', 'dab rigs', 'hand pipes', 'storage', 'grinders'],
    pricePosition: 'mid-premium' },
  { domain: 'thedablab.com', name: 'The Dab Lab', threatLevel: 'LOW',
    categories: ['monark glass', 'dab rigs', 'hand pipes', 'dab tools', 'quartz bangers', 'carb caps'],
    pricePosition: 'mid-premium',
    notes: 'Pacifica CA. Since 2011. High-end glass gallery.' },
  { domain: 'tvape.com', name: 'TVape', threatLevel: 'LOW',
    categories: ['lookah', 'vaporizers'],
    notes: 'Vaporizer specialist. Detailed reviews.' },
  { domain: 'delta8resellers.com', name: 'Delta 8 Resellers', threatLevel: 'LOW',
    categories: ['smyle labs', '510 batteries'],
    pricePosition: 'mid-market' },
  { domain: 'shopsmokeless.com', name: 'Shopsmokeless', threatLevel: 'LOW',
    categories: ['lookah', 'vaporizers', '510 batteries', 'dab pens'] },
  { domain: 'e-nail.com', name: 'E-Nail.com', threatLevel: 'LOW',
    categories: ['lookah', 'e-nails', 'dab accessories'] },
  { domain: 'cannabox.com', name: 'Cannabox', threatLevel: 'LOW',
    categories: ['clipper', 'rolling accessories', 'glass'] },
  { domain: 'nycglass718.com', name: 'NYC Glass', threatLevel: 'LOW',
    categories: ['lookah', 'glass'] },
  { domain: 'headdyglass.com', name: 'Headdy Glass', threatLevel: 'LOW',
    categories: ['dab rigs', 'glass pipes', 'recyclers'],
    pricePosition: 'budget' },
  { domain: 'snowtreeworldwide.com', name: 'SnowTree', threatLevel: 'LOW',
    categories: ['maven torches', 'glass bongs', 'dab rigs', 'hand pipes', 'grinders'] },
  { domain: 'wetvapes.com', name: 'Wet Vapes', threatLevel: 'LOW',
    categories: ['maven torches', 'lookah', 'glass pipes', 'vaporizers'] },
  { domain: 'iloveexcitementsmokin.com', name: 'Excitement Smokin PA', threatLevel: 'LOW',
    categories: ['monark glass', 'water pipes', 'dab rigs', 'quartz'] },
  { domain: 'smokersvalley.com', name: 'Smokers Valley', threatLevel: 'LOW',
    categories: ['monark glass', 'glass bongs', 'dab rigs', 'recyclers', 'bangers'] },
  { domain: 'greenheadshop.com', name: 'Green Headshop', threatLevel: 'LOW',
    categories: ['cookies glass', 'glass bongs', 'dab rigs', 'hand pipes'] },
  { domain: 'puresativa.com', name: 'Pure Sativa', threatLevel: 'LOW',
    categories: ['cookies glass', 'glass bongs', 'dab rigs'] },

  // BASELINE — Brand DTC Channels (MSRP reference)
  { domain: 'lookah.com', name: 'Lookah Official', threatLevel: 'MEDIUM',
    categories: ['lookah', 'electronics'],
    pricePosition: 'msrp',
    notes: 'Brand DTC. MSRP reference. Dragon Egg $99, all coils.' },
  { domain: 'lookahusa.com', name: 'Lookah USA', threatLevel: 'LOW',
    categories: ['lookah'],
    pricePosition: 'msrp',
    notes: 'Authorized Lookah parts/accessories retailer.' },
  { domain: 'smylelabs.com', name: 'Smyle Labs Official', threatLevel: 'MEDIUM',
    categories: ['smyle labs', 'electronics'],
    pricePosition: 'msrp',
    notes: 'Brand DTC. Penjamin Cart Pen at $29.99. Free shipping. 60-day money-back.' },
  { domain: 'glasscookiessf.com', name: 'Cookies Glass Direct', threatLevel: 'MEDIUM',
    categories: ['cookies glass'],
    pricePosition: 'msrp',
    notes: 'Official Cookies Glass website. MSRP baseline pricing. Blue tag authenticity.' },
  { domain: 'monarkgallery.com', name: 'Monark Gallery', threatLevel: 'MEDIUM',
    categories: ['monark glass'],
    pricePosition: 'msrp',
    notes: 'Official Monark DTC. MSRP reference.' },
  { domain: 'maventorch.com', name: 'Maven Torch (DTC)', threatLevel: 'MEDIUM',
    categories: ['maven torches', 'torches'],
    pricePosition: 'msrp',
    notes: 'Official Maven DTC. K2 MSRP $54.99.' },
  { domain: 'zigzag.com', name: 'Zig-Zag Official', threatLevel: 'LOW',
    categories: ['zig zag', 'rolling papers'],
    pricePosition: 'msrp',
    notes: 'Brand DTC. 140+ year heritage. Exclusive bundles.' },
  { domain: 'vibespapers.com', name: 'Vibes Papers Official', threatLevel: 'LOW',
    categories: ['vibes', 'rolling papers'],
    pricePosition: 'msrp',
    notes: 'Brand DTC. French-made papers. Berner brand.' },
  { domain: 'blazysusan.com', name: 'Blazy Susan (DTC)', threatLevel: 'LOW',
    categories: ['blazy susan', 'rolling papers'],
    pricePosition: 'msrp',
    notes: 'Brand DTC. Per-booklet pricing (compare to box/display pricing carefully).' },
  { domain: 'rawthentic.com', name: 'RAW (DTC)', threatLevel: 'LOW',
    categories: ['raw', 'rolling papers'],
    pricePosition: 'msrp',
    notes: 'Official RAW site. Authenticity verification tools.' },
  { domain: 'bsgwholesale.com', name: 'Black Sheep / BSG Wholesale', threatLevel: 'LOW',
    categories: ['encore glass', 'monark glass'],
    pricePosition: 'wholesale',
    notes: 'Parent distributor for Encore, Black Sheep, Monark brands. Wholesale only.' },
];

// ============================================================================
// KNOWN PRICE BENCHMARKS — Oil Slick packaging products
// ============================================================================
// Source: Competitor web research for Oil Slick product categories.
// Prices are per-pack/per-case as listed on competitor sites.

const OIL_SLICK_PRICE_BENCHMARKS: KnownPriceBenchmark[] = [
  // === CHILD-RESISTANT GLASS JARS (10oz / 14g / 1/2 oz capacity) ===
  // Lookahead regex matches regardless of word order: "10oz Glass Jar with CR Lid"
  // AND "10oz CR Glass Jar" both match
  { productPattern: /10\s*oz(?=.*(?:child.?resistant|cr))(?=.*(?:glass\s*jar|jar))/i,
    competitorDomain: 'greenrushpackaging.com', competitorName: 'Green Rush Packaging', price: 30.64,
    category: 'Glass Jars', notes: '36ct case. White CR lid. Lowest price found.' },
  { productPattern: /10\s*oz(?=.*(?:child.?resistant|cr))(?=.*(?:glass\s*jar|jar))/i,
    competitorDomain: 'greatpacificpackaging.com', competitorName: 'Great Pacific Packaging', price: 35.50,
    category: 'Glass Jars', notes: '36/case. Matte black CR lid.' },
  { productPattern: /10\s*oz(?=.*(?:child.?resistant|cr))(?=.*(?:glass\s*jar|jar))/i,
    competitorDomain: 'thevialstore.com', competitorName: 'The Vial Store', price: 59.99,
    category: 'Glass Jars', notes: '36ct. Grade A pharmaceutical glass, black CR cap.' },
  { productPattern: /10\s*oz(?=.*(?:child.?resistant|cr))(?=.*(?:glass\s*jar|jar))/i,
    competitorDomain: 'greentechpackaging.com', competitorName: 'Green Tech Packaging', price: 77.04,
    category: 'Glass Jars', notes: '72ct ($154.08), normalized to 36ct equivalent.' },
  { productPattern: /10\s*oz.*(?:glass\s*jar|jar).*(?:straight|clear)/i,
    competitorDomain: '420packaging.com', competitorName: '420 Packaging', price: 24.95,
    category: 'Glass Jars', notes: '36ct. Straight-sided clear glass. May not include CR lid.' },

  // === 7ml UV-RESISTANT CONCENTRATE JARS (small, heavy bottom) ===
  // All prices normalized to 80ct pack equivalent for consistent comparison
  { productPattern: /7\s*ml.*(?:uv|glass).*(?:jar|container)/i,
    competitorDomain: 'amazon.com', competitorName: 'Amazon', price: 63.99,
    category: 'Glass Jars', notes: '80ct pack. UV resistant heavy bottom, CR black lids. Exact match.' },
  { productPattern: /7\s*ml.*(?:uv|glass).*(?:jar|container)/i,
    competitorDomain: 'greentechpackaging.com', competitorName: 'Green Tech Packaging', price: 21.60,
    category: 'Glass Jars', notes: '320ct @ $86.40 = $0.27/unit. Normalized to 80ct equivalent.' },
  { productPattern: /7\s*ml.*(?:uv|glass).*(?:jar|container)/i,
    competitorDomain: 'premiumvials.com', competitorName: 'Premium Vials', price: 22.50,
    category: 'Glass Jars', notes: '320ct @ $89.99 = $0.28/unit. Normalized to 80ct equivalent.' },
  { productPattern: /7\s*ml.*(?:concentrate|glass).*(?:jar|container)/i,
    competitorDomain: 'dragonchewer.com', competitorName: 'Dragon Chewer', price: 44.99,
    category: 'Glass Jars', notes: '7ml premium glass concentrate jars. Approx 80ct equivalent.' },

  // === CHILD-RESISTANT GLASS JARS (other sizes) ===
  // Lookahead regex matches regardless of word order: "5 oz Glass Jar with Black CR Lid"
  // AND "5 oz CR Glass Jar" both match (jar and CR can appear in either order)
  { productPattern: /(?:1|2|3|4|5)\s*oz(?=.*(?:child.?resistant|cr))(?=.*(?:glass\s*jar|jar))/i,
    competitorDomain: 'dragonchewer.com', competitorName: 'Dragon Chewer', price: 18.99,
    category: 'Glass Jars', notes: 'Small CR jars ~$15-25 per case. Supercell jar line.' },
  { productPattern: /(?:1|2|3|4|5)\s*oz(?=.*(?:child.?resistant|cr))(?=.*(?:glass\s*jar|jar))/i,
    competitorDomain: '420packaging.com', competitorName: '420 Packaging', price: 14.95,
    category: 'Glass Jars', notes: 'Small CR jars. Price-beat guarantee.' },

  // === MYLAR BAGS ===
  { productPattern: /mylar\s*bag/i,
    competitorDomain: '420packaging.com', competitorName: '420 Packaging', price: 12.99,
    category: 'Mylar Bags', notes: 'Per 100ct pack. Wide selection.' },
  { productPattern: /mylar\s*bag/i,
    competitorDomain: 'cannaline.com', competitorName: 'Cannaline', price: 15.99,
    category: 'Mylar Bags', notes: 'Compound film barrier bags. Custom printing available.' },

  // === PRE-ROLL TUBES ===
  { productPattern: /pre.?roll\s*tube/i,
    competitorDomain: '420packaging.com', competitorName: '420 Packaging', price: 9.99,
    category: 'Pre-Roll Tubes', notes: 'Per 100ct pack. CR options available.' },
  { productPattern: /pre.?roll\s*tube/i,
    competitorDomain: 'dragonchewer.com', competitorName: 'Dragon Chewer', price: 11.99,
    category: 'Pre-Roll Tubes', notes: 'CR-focused pre-roll packaging.' },

  // === SYRINGES ===
  { productPattern: /(?:glass\s*)?syringe/i,
    competitorDomain: 'gamutpackaging.com', competitorName: 'Gamut Packaging', price: 24.99,
    category: 'Syringes', notes: 'Glass syringes. Luer lock tips.' },

  // === FEP / PTFE ===
  { productPattern: /fep\s*(?:sheet|liner|film)/i,
    competitorDomain: '420stock.com', competitorName: '420 Stock', price: 8.99,
    category: 'FEP', notes: 'Aggressive FEP pricing.' },
  { productPattern: /fep\s*(?:sheet|liner|film)/i,
    competitorDomain: 'thepressclub.co', competitorName: 'The Press Club', price: 14.99,
    category: 'FEP', notes: 'FEP sheets. Extraction community brand.' },

  // === SILICONE PADS / DAB MATS ===
  { productPattern: /silicone\s*(?:pad|mat|dab\s*mat)/i,
    competitorDomain: 'vsyndicate.com', competitorName: 'V Syndicate (Slikks)', price: 19.99,
    category: 'Silicone Pads', notes: 'Licensed art prints on silicone.' },
];

// ============================================================================
// KNOWN PRICE BENCHMARKS — Actual competitor prices from WYN research
// ============================================================================
// Source: WYN_Vendor_Tagged_Competitors_FINAL.xlsx — Price Benchmarks sheet
// These are injected as pre-populated competitor data (highest confidence).

const WYN_PRICE_BENCHMARKS: KnownPriceBenchmark[] = [
  // === LOOKAH ELECTRONICS ===
  { productPattern: /lookah\s+seahorse\s+pro\s+plus/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 27.99,
    category: 'Electronics', notes: 'CRITICAL: 115% above. Vape specialists aggressively undercut.' },
  { productPattern: /lookah\s+seahorse\s+pro\s+plus/i, brand: 'Lookah',
    competitorDomain: 'discountvapepen.com', competitorName: 'Discount Vape Pen', price: 32.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+seahorse\s+pro\s+plus/i, brand: 'Lookah',
    competitorDomain: 'smokeday.com', competitorName: 'SmokeDay', price: 39.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+dragon\s+egg/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 59.99,
    category: 'Electronics', notes: '67% above. Common street price $66-$80.' },
  { productPattern: /lookah\s+dragon\s+egg/i, brand: 'Lookah',
    competitorDomain: 'cityvaporizer.com', competitorName: 'CityVaporizer', price: 66.00,
    category: 'Electronics' },
  { productPattern: /lookah\s+dragon\s+egg/i, brand: 'Lookah',
    competitorDomain: 'smokeday.com', competitorName: 'SmokeDay', price: 69.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+dragon\s+egg/i, brand: 'Lookah',
    competitorDomain: 'discountvapepen.com', competitorName: 'Discount Vape Pen', price: 72.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+dragon\s+egg/i, brand: 'Lookah',
    competitorDomain: 'lookah.com', competitorName: 'Lookah Official (MSRP)', price: 99.00,
    category: 'Electronics', notes: 'MSRP reference.' },
  { productPattern: /lookah\s+unicorn\s+mini/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 42.99,
    category: 'Electronics', notes: 'LARGEST DELTA IN CATALOG: $147 above EV.' },
  { productPattern: /lookah\s+unicorn\s+mini/i, brand: 'Lookah',
    competitorDomain: 'american420smokeshop.com', competitorName: 'American 420', price: 89.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+ice\s+cream/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 39.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+ant/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 29.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+guitar/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 19.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+cat(?:\s|$)/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 17.99,
    category: 'Electronics' },
  { productPattern: /lookah\s+egg(?:\s|$)/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 14.99,
    category: 'Electronics', notes: 'Avoid matching "Dragon Egg" — this is the standalone Egg 510 battery.' },
  { productPattern: /lookah\s+zero/i, brand: 'Lookah',
    competitorDomain: 'elementvape.com', competitorName: 'Element Vape', price: 17.99,
    category: 'Electronics' },

  // === SMYLE LABS / NOVELTY BATTERIES ===
  { productPattern: /(?:smyle|penjamin)\s+(?:cart\s+)?(?:writing\s+)?pen/i, brand: 'Smyle',
    competitorDomain: 'smylelabs.com', competitorName: 'Smyle Labs Direct', price: 29.99,
    category: 'Electronics', notes: 'Brand DTC. $10 below WYN price.' },
  { productPattern: /(?:smyle|penjamin)\s+(?:cart\s+)?(?:writing\s+)?pen/i, brand: 'Smyle',
    competitorDomain: 'boomheadshop.com', competitorName: 'Boom Headshop', price: 34.99,
    category: 'Electronics' },
  { productPattern: /(?:smyle|penjamin)\s+(?:permanent\s+)?marker/i, brand: 'Smyle',
    competitorDomain: 'smylelabs.com', competitorName: 'Smyle Labs Direct', price: 24.99,
    category: 'Electronics' },
  { productPattern: /(?:smyle|penjamin)\s+lip\s+balm/i, brand: 'Smyle',
    competitorDomain: 'smylelabs.com', competitorName: 'Smyle Labs Direct', price: 24.99,
    category: 'Electronics' },
  { productPattern: /(?:smyle|penjamin)\s+raygun/i, brand: 'Smyle',
    competitorDomain: 'smylelabs.com', competitorName: 'Smyle Labs Direct', price: 44.99,
    category: 'Electronics' },
  { productPattern: /(?:smyle|penjamin)\s+purse/i, brand: 'Smyle',
    competitorDomain: 'smylelabs.com', competitorName: 'Smyle Labs Direct', price: 49.99,
    category: 'Electronics' },
  { productPattern: /(?:smyle|penjamin)\s+robot/i, brand: 'Smyle',
    competitorDomain: 'smylelabs.com', competitorName: 'Smyle Labs Direct', price: 79.99,
    category: 'Electronics', notes: 'Limited edition. Collectibility supports pricing.' },
  { productPattern: /wandjamin/i, brand: 'Smyle',
    competitorDomain: 'smylelabs.com', competitorName: 'Smyle Labs Direct', price: 52.50,
    category: 'Electronics' },

  // === COOKIES GLASS (MAP pricing generally holds) ===
  { productPattern: /cookies.*v\s*beaker|14.*cookies.*beaker/i, brand: 'Cookies',
    competitorDomain: 'aqualabtechnologies.com', competitorName: 'Aqua Lab / Boom / Pulsar', price: 339.99,
    category: 'Cookies Glass', notes: 'MAP pricing enforced across all authorized retailers.' },
  { productPattern: /cookies.*beaker.*dome|17.*cookies.*beaker/i, brand: 'Cookies',
    competitorDomain: 'aqualabtechnologies.com', competitorName: 'Aqua Lab Technologies', price: 349.99,
    category: 'Cookies Glass', notes: 'MAP enforced.' },
  { productPattern: /cookies.*flame.*beaker/i, brand: 'Cookies',
    competitorDomain: 'smokecartel.com', competitorName: 'Smoke Cartel', price: 289.99,
    category: 'Cookies Glass' },
  { productPattern: /cookies.*double.*cycler/i, brand: 'Cookies',
    competitorDomain: 'dankgeek.com', competitorName: 'DankGeek', price: 219.99,
    category: 'Cookies Glass', notes: 'DankGeek may run sales. $40 gap. Watch for promo pricing.' },
  { productPattern: /cookies.*incycler/i, brand: 'Cookies',
    competitorDomain: 'pulsarshop.com', competitorName: 'Pulsar', price: 199.99,
    category: 'Cookies Glass' },
  { productPattern: /cookies.*flowcycler|9.*cookies.*flowcycler/i, brand: 'Cookies',
    competitorDomain: 'multiple', competitorName: 'Multiple authorized', price: 169.99,
    category: 'Cookies Glass', notes: 'Consistent MAP pricing across authorized retailers.' },

  // === MONARK GLASS ===
  { productPattern: /monark.*world.*largest.*incycler|18.*monark.*incycler/i, brand: 'Monark',
    competitorDomain: 'monarkgallery.com', competitorName: 'Monark Gallery (DTC)', price: 474.99,
    category: 'Monark Glass', notes: 'MSRP parity with DTC. Premium flagship piece.' },
  { productPattern: /monark.*50mm.*triple.*ratchet/i, brand: 'Monark',
    competitorDomain: 'highrollersmoke.com', competitorName: 'High Roller Smoke', price: 225.00,
    category: 'Monark Glass' },
  { productPattern: /13.*monark.*recycler/i, brand: 'Monark',
    competitorDomain: 'thesmokeshopguys.com', competitorName: 'The Smoke Shop Guys', price: 149.99,
    category: 'Monark Glass', notes: 'LARGE DELTA: Verify same SKU/model. If confirmed, reprice.' },

  // === ENCORE GLASS ===
  { productPattern: /encore.*color.*accent.*turbine/i, brand: 'Encore',
    competitorDomain: 'highrollersmoke.com', competitorName: 'High Roller Smoke', price: 99.99,
    category: 'Encore Glass', notes: 'Limited online retail distribution = WYN competitive advantage.' },
  { productPattern: /encore.*yoshi.*egg.*recycler/i, brand: 'Encore',
    competitorDomain: 'highrollersmoke.com', competitorName: 'High Roller Smoke', price: 180.00,
    category: 'Encore Glass' },

  // === MAVEN TORCHES ===
  { productPattern: /maven.*k-?2/i, brand: 'Maven',
    competitorDomain: 'maventorch.com', competitorName: 'Maven Direct (MSRP)', price: 54.99,
    category: 'Torches', notes: 'MSRP. WYN at $49.99 is BELOW MSRP — strong positioning.' },
  { productPattern: /maven.*k-?2/i, brand: 'Maven',
    competitorDomain: 'dankgeek.com', competitorName: 'DankGeek', price: 44.99,
    category: 'Torches', notes: 'CaliConnected also at $44.99 with price match.' },
  { productPattern: /maven.*hurricane/i, brand: 'Maven',
    competitorDomain: 'monstersmokeshops.com', competitorName: 'Monster Smoke Shops', price: 99.99,
    category: 'Torches' },
  { productPattern: /maven.*volt/i, brand: 'Maven',
    competitorDomain: 'kcsmokeshop.com', competitorName: 'KC Smoke Shop', price: 34.99,
    category: 'Torches' },

  // === ROLLING PAPERS ===
  { productPattern: /raw.*classic.*1.*1\/4|raw.*classic.*1.*¼/i, brand: 'RAW',
    competitorDomain: 'multiple', competitorName: 'Multiple Headshops', price: 19.99,
    category: 'Rolling Papers', notes: 'RAW holds pricing well. MAP enforced.' },
  { productPattern: /raw.*black.*classic.*1.*1\/4|raw.*black.*1.*¼/i, brand: 'RAW',
    competitorDomain: 'multiple', competitorName: 'Multiple Headshops', price: 49.99,
    category: 'Rolling Papers', notes: '$5 premium on WYN end. High-demand SKU.' },
  { productPattern: /zig\s*zag.*1.*1\/4.*ultra\s*thin|zig\s*zag.*ultra\s*thin.*1.*¼/i, brand: 'Zig Zag',
    competitorDomain: 'multiple', competitorName: 'Multiple', price: 44.99,
    category: 'Rolling Papers' },
  { productPattern: /vibes.*king.*size.*slim/i, brand: 'Vibes',
    competitorDomain: 'multiple', competitorName: 'Multiple', price: 89.99,
    category: 'Rolling Papers', notes: 'Vibes maintains MAP. Berner brand loyalty supports pricing.' },
  { productPattern: /ocb.*bamboo.*1.*¼.*cone.*100/i, brand: 'OCB',
    competitorDomain: 'multiple', competitorName: 'Multiple', price: 29.99,
    category: 'Rolling Papers' },
];

// ============================================================================
// Oil Slick product category mapping
// Maps common product terms to the category keys used in OIL_SLICK_COMPETITORS
// ============================================================================
const OIL_SLICK_CATEGORY_MAP: Record<string, string[]> = {
  // Glass jars
  'jar': ['glass jars'],
  'concentrate jar': ['glass jars'],
  'glass jar': ['glass jars'],
  'cr jar': ['glass jars'],
  'flower jar': ['glass jars'],
  'uv jar': ['glass jars'],

  // FEP / PTFE
  'fep': ['fep'],
  'fep sheet': ['fep'],
  'fep roll': ['fep'],
  'ptfe': ['ptfe'],
  'ptfe roll': ['ptfe'],
  'nonstick': ['fep', 'ptfe', 'parchment'],

  // Silicone
  'silicone': ['silicone pads'],
  'dab pad': ['silicone pads'],
  'dab mat': ['silicone pads'],
  'silicone pad': ['silicone pads'],
  'silicone mat': ['silicone pads'],
  'slick pad': ['silicone pads'],

  // Mylar bags
  'mylar': ['mylar bags'],
  'mylar bag': ['mylar bags'],
  'smell proof': ['mylar bags'],
  'barrier bag': ['mylar bags'],

  // Pre-roll tubes
  'pre-roll': ['pre-roll tubes'],
  'preroll': ['pre-roll tubes'],
  'tube': ['pre-roll tubes'],
  'pop top': ['pre-roll tubes'],

  // Syringes
  'syringe': ['syringes'],
  'glass syringe': ['syringes'],
  'luer lock': ['syringes'],
  'applicator': ['syringes'],

  // Parchment / rosin paper
  'parchment': ['parchment'],
  'rosin': ['parchment'],
  'rosin paper': ['parchment'],
  'nonstick paper': ['parchment'],

  // Custom / branding
  'custom': ['custom packaging'],
  'label': ['custom packaging'],
  'sticker': ['custom packaging'],
  'canvas': ['custom packaging'],
};

// ============================================================================
// WYN brand → category mapping for quick lookup
// ============================================================================
const WYN_BRAND_CATEGORIES: Record<string, string[]> = {
  'lookah': ['electronics', 'lookah', 'vaporizers', '510 batteries'],
  'smyle': ['electronics', 'smyle labs'],
  'smyle labs': ['electronics', 'smyle labs'],
  'penjamin': ['electronics', 'smyle labs'],
  'cookies': ['cookies glass'],
  'cookies glass': ['cookies glass'],
  'monark': ['monark glass'],
  'monark glass': ['monark glass'],
  'encore': ['encore glass'],
  'encore glass': ['encore glass'],
  'maven': ['maven torches', 'torches'],
  'aleaf': ['aleaf', 'torches'],
  'zig zag': ['zig zag', 'rolling papers'],
  'zig-zag': ['zig zag', 'rolling papers'],
  'vibes': ['vibes', 'rolling papers'],
  'raw': ['raw', 'rolling papers'],
  'blazy susan': ['blazy susan', 'rolling papers'],
  'blazy': ['blazy susan', 'rolling papers'],
  'elements': ['elements', 'rolling papers'],
  'clipper': ['clipper'],
  'ocb': ['rolling papers'],
  'cyclones': ['rolling papers'],
  'black sheep': ['monark glass', 'encore glass'],
};

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Determine if a vendor matches Oil Slick products.
 */
export function isOilSlickVendor(vendor: string | null): boolean {
  if (!vendor) return false;
  const v = vendor.toLowerCase();
  return v.includes('oil slick') || v.includes('oilslick');
}

/**
 * Determine if a vendor matches WYN / Cloud YHS products.
 */
export function isWYNVendor(vendor: string | null): boolean {
  if (!vendor) return false;
  const v = vendor.toLowerCase();
  return v.includes('cloud yhs') || v.includes('what you need') || v.includes('wyn')
    || v.includes('cloudyhs');
}

/**
 * Get the list of competitor domains to search for a given product,
 * ordered by relevance (HIGH threat first).
 */
export function getCompetitorDomains(
  vendor: string | null,
  productType: string | null,
  identity: ProductIdentity | null,
): string[] {
  const domains: string[] = [];

  if (isOilSlickVendor(vendor)) {
    // For Oil Slick: find competitors that match the product category
    const matchedCategories = matchOilSlickCategories(productType, identity);
    const sorted = [...OIL_SLICK_COMPETITORS]
      .filter(c => matchedCategories.length === 0 || c.categories.some(cat => matchedCategories.includes(cat)))
      .sort((a, b) => threatOrder(a.threatLevel) - threatOrder(b.threatLevel));
    for (const c of sorted) {
      if (!domains.includes(c.domain)) domains.push(c.domain);
    }
  } else if (isWYNVendor(vendor)) {
    // For WYN: find competitors that carry overlapping brands/categories
    const matchedCategories = matchWYNCategories(vendor, productType, identity);
    const sorted = [...WYN_COMPETITORS]
      .filter(c => matchedCategories.length === 0 || c.categories.some(cat => matchedCategories.includes(cat)))
      .sort((a, b) => threatOrder(a.threatLevel) - threatOrder(b.threatLevel));
    for (const c of sorted) {
      if (!domains.includes(c.domain)) domains.push(c.domain);
    }
  }

  return domains;
}

/**
 * Get known price benchmarks for a product.
 * Returns CompetitorPrice[] that can be merged directly into search results.
 */
export function getKnownPriceBenchmarks(
  product: { title: string; vendor: string | null; productType: string | null },
  identity: ProductIdentity | null,
): CompetitorPrice[] {
  const results: CompetitorPrice[] = [];
  const title = product.title || '';
  const brand = product.vendor || identity?.brand || '';

  // Search both Oil Slick and WYN price benchmarks
  const allBenchmarks = [...OIL_SLICK_PRICE_BENCHMARKS, ...WYN_PRICE_BENCHMARKS];

  for (const benchmark of allBenchmarks) {
    // Check if product title matches the pattern
    if (!benchmark.productPattern.test(title)) continue;

    // Check brand filter if specified
    if (benchmark.brand) {
      const brandLower = brand.toLowerCase();
      const benchBrandLower = benchmark.brand.toLowerCase();
      // Check vendor, brand from identity, or product title for brand match
      const titleLower = title.toLowerCase();
      if (!brandLower.includes(benchBrandLower) && !titleLower.includes(benchBrandLower)) {
        // Also check identity brand
        const identityBrand = (identity?.brand || '').toLowerCase();
        if (!identityBrand.includes(benchBrandLower)) continue;
      }
    }

    results.push({
      source: benchmark.competitorDomain,
      url: `https://${benchmark.competitorDomain}`,
      title: `${benchmark.competitorName}: ${title}`,
      price: benchmark.price,
      extractionMethod: 'local-competitor-database',
      isKnownRetailer: true,
      inStock: true,
    });
  }

  return results;
}

/**
 * Get ALL known competitor domains across both vendors.
 * Used to update RETAIL_SMOKE_SHOPS lists across search modules.
 */
export function getAllCompetitorDomains(): string[] {
  const domains = new Set<string>();
  for (const c of OIL_SLICK_COMPETITORS) domains.add(c.domain);
  for (const c of WYN_COMPETITORS) domains.add(c.domain);
  return [...domains];
}

/**
 * Build a search instruction string for AI-powered search prompts.
 * Returns a prioritized list of sites to search for the given product.
 */
export function buildSearchInstruction(
  vendor: string | null,
  productType: string | null,
  identity: ProductIdentity | null,
): string {
  const domains = getCompetitorDomains(vendor, productType, identity);
  if (domains.length === 0) return '';

  // Take top 10 most relevant competitors
  const topDomains = domains.slice(0, 10);

  const vendorLabel = isOilSlickVendor(vendor)
    ? 'OIL SLICK'
    : isWYNVendor(vendor)
    ? 'CLOUD YHS / WHAT YOU NEED'
    : 'this vendor';

  return `
PRIORITY COMPETITOR SITES for ${vendorLabel} products (search these FIRST):
${topDomains.map((d, i) => `   ${i + 1}. site:${d}`).join('\n')}

These are the PRIMARY competitors for this product. Their prices carry the HIGHEST weight.
Search each of these sites before doing general web searches.`;
}

// ============================================================================
// Internal helpers
// ============================================================================

function threatOrder(level: 'HIGH' | 'MEDIUM' | 'LOW'): number {
  return level === 'HIGH' ? 0 : level === 'MEDIUM' ? 1 : 2;
}

function matchOilSlickCategories(
  productType: string | null,
  identity: ProductIdentity | null,
): string[] {
  const categories = new Set<string>();
  const searchTerms = [
    productType,
    identity?.productType,
    identity?.identifiedAs,
    ...(identity?.keyFeatures || []),
  ].filter(Boolean).map(s => s!.toLowerCase());

  for (const term of searchTerms) {
    for (const [keyword, cats] of Object.entries(OIL_SLICK_CATEGORY_MAP)) {
      if (term.includes(keyword)) {
        for (const cat of cats) categories.add(cat);
      }
    }
  }

  return [...categories];
}

function matchWYNCategories(
  vendor: string | null,
  productType: string | null,
  identity: ProductIdentity | null,
): string[] {
  const categories = new Set<string>();
  const brand = (identity?.brand || vendor || '').toLowerCase();
  const titleTerms = [
    productType,
    identity?.productType,
    identity?.identifiedAs,
  ].filter(Boolean).map(s => s!.toLowerCase());

  // Check brand mapping
  for (const [key, cats] of Object.entries(WYN_BRAND_CATEGORIES)) {
    if (brand.includes(key) || titleTerms.some(t => t.includes(key))) {
      for (const cat of cats) categories.add(cat);
    }
  }

  // Fallback: try to match product type to generic glass/accessory categories
  if (categories.size === 0) {
    const allTerms = titleTerms.join(' ');
    if (allTerms.includes('bong') || allTerms.includes('water pipe')) categories.add('glass bongs');
    if (allTerms.includes('rig') || allTerms.includes('dab rig')) categories.add('dab rigs');
    if (allTerms.includes('pipe') || allTerms.includes('hand pipe')) categories.add('hand pipes');
    if (allTerms.includes('recycler')) categories.add('recyclers');
    if (allTerms.includes('bubbler')) categories.add('bubblers');
    if (allTerms.includes('grinder')) categories.add('grinders');
    if (allTerms.includes('quartz') || allTerms.includes('banger')) categories.add('quartz');
    if (allTerms.includes('carb cap')) categories.add('carb caps');
    if (allTerms.includes('nectar collector')) categories.add('nectar collectors');
    if (allTerms.includes('torch')) categories.add('torches');
    if (allTerms.includes('paper') || allTerms.includes('rolling') || allTerms.includes('cone')) categories.add('rolling papers');
    if (allTerms.includes('vaporizer') || allTerms.includes('vape') || allTerms.includes('battery')) categories.add('electronics');
  }

  return [...categories];
}
