// ============================================================================
// Smart Model Router — picks the cheapest capable model for each pipeline step
// ============================================================================
// Instead of using one expensive model for everything, each step in the
// pricing pipeline gets routed to the right-sized model:
//
//   Step            | Default Model        | Fast Model          | Why
//   ────────────────|──────────────────────|────────────────────|──────
//   identify        | gpt-4.1-nano         | gpt-4.1-nano       | Simple classification
//   visual          | gemini-2.5-flash     | gemini-2.5-flash   | Best vision/cost ratio
//   search          | gemini-2.5-flash     | gemini-2.5-flash   | Google Search grounding free
//   analyze         | gpt-4.1-mini         | gpt-4.1-nano       | Core reasoning
//   deliberate      | gpt-4.1-mini         | (skipped)          | Deep reasoning fallback
//   reflect         | gpt-4.1-nano         | (skipped)          | Query generation
//
// Total per-product cost: ~$0.01-0.03 (down from ~$0.10-0.25 with GPT-5.2)
//
// Overrideable via CLI --provider flag to force a single provider for all steps.

import { chatCompletion } from './openai';
import { claudeChatCompletion } from './claude';
import { geminiChatCompletion } from './gemini';
import type { Provider } from './pricing-engine';

// ---------------------------------------------------------------------------
// Pipeline step types
// ---------------------------------------------------------------------------

export type PipelineStep =
  | 'identify'      // Product classification (trivial)
  | 'visual'        // Image analysis (needs vision model)
  | 'search'        // Competitor search (needs grounding)
  | 'analyze'       // Core pricing analysis (needs good reasoning)
  | 'deliberate'    // Deep deliberation (needs strong reasoning)
  | 'reflect';      // Search query regeneration (trivial)

// ---------------------------------------------------------------------------
// Model selection configuration
// ---------------------------------------------------------------------------

export interface ModelSelection {
  provider: Provider;
  model: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completionFn: (options: any) => Promise<string>;
}

interface StepConfig {
  provider: Provider;
  model: string;
  fastModel: string;  // Used when --fast flag is set
}

// Default routing: each step uses the cheapest capable model
const DEFAULT_STEP_CONFIG: Record<PipelineStep, StepConfig> = {
  identify: {
    provider: 'openai',
    model: 'gpt-4.1-nano',
    fastModel: 'gpt-4.1-nano',
  },
  visual: {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    fastModel: 'gemini-2.5-flash',
  },
  search: {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    fastModel: 'gemini-2.5-flash',
  },
  analyze: {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    fastModel: 'gpt-4.1-nano',
  },
  deliberate: {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    fastModel: 'gpt-4.1-nano',
  },
  reflect: {
    provider: 'openai',
    model: 'gpt-4.1-nano',
    fastModel: 'gpt-4.1-nano',
  },
};

// When a specific provider is forced (--provider flag), use that provider's best models
const PROVIDER_MODELS: Record<Provider, Record<PipelineStep, { model: string; fastModel: string }>> = {
  openai: {
    identify:    { model: 'gpt-4.1-nano',  fastModel: 'gpt-4.1-nano' },
    visual:      { model: 'gpt-4.1-mini',  fastModel: 'gpt-4.1-nano' },  // OpenAI vision
    search:      { model: 'gpt-4.1-mini',  fastModel: 'gpt-4.1-nano' },  // OpenAI web search
    analyze:     { model: 'gpt-4.1-mini',  fastModel: 'gpt-4.1-nano' },
    deliberate:  { model: 'gpt-4.1-mini',  fastModel: 'gpt-4.1-nano' },
    reflect:     { model: 'gpt-4.1-nano',  fastModel: 'gpt-4.1-nano' },
  },
  claude: {
    identify:    { model: 'claude-haiku-4-5-20251001',    fastModel: 'claude-haiku-4-5-20251001' },
    visual:      { model: 'claude-sonnet-4-5-20250929',   fastModel: 'claude-haiku-4-5-20251001' },
    search:      { model: 'claude-sonnet-4-5-20250929',   fastModel: 'claude-haiku-4-5-20251001' },
    analyze:     { model: 'claude-sonnet-4-5-20250929',   fastModel: 'claude-haiku-4-5-20251001' },
    deliberate:  { model: 'claude-sonnet-4-5-20250929',   fastModel: 'claude-haiku-4-5-20251001' },
    reflect:     { model: 'claude-haiku-4-5-20251001',    fastModel: 'claude-haiku-4-5-20251001' },
  },
  gemini: {
    identify:    { model: 'gemini-2.5-flash', fastModel: 'gemini-2.5-flash' },
    visual:      { model: 'gemini-2.5-flash', fastModel: 'gemini-2.5-flash' },
    search:      { model: 'gemini-2.5-flash', fastModel: 'gemini-2.5-flash' },
    analyze:     { model: 'gemini-2.5-flash', fastModel: 'gemini-2.5-flash' },
    deliberate:  { model: 'gemini-2.5-flash', fastModel: 'gemini-2.5-flash' },
    reflect:     { model: 'gemini-2.5-flash', fastModel: 'gemini-2.5-flash' },
  },
};

// ---------------------------------------------------------------------------
// Completion function lookup
// ---------------------------------------------------------------------------

function getCompletionFnForProvider(provider: Provider) {
  switch (provider) {
    case 'claude': return claudeChatCompletion;
    case 'gemini': return geminiChatCompletion;
    default: return chatCompletion;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RouterOptions {
  /** Force all steps to use this provider (null = smart routing) */
  forcedProvider?: Provider | null;
  /** Use cheapest models (fast mode) */
  fast?: boolean;
}

/**
 * Get the optimal model + provider for a given pipeline step.
 *
 * With no forced provider (default), each step routes to the cheapest capable model
 * across all providers. With --provider set, all steps use that provider.
 */
export function getModelForStep(step: PipelineStep, options: RouterOptions = {}): ModelSelection {
  const { forcedProvider = null, fast = false } = options;

  let provider: Provider;
  let model: string;

  if (forcedProvider) {
    // Forced provider: use that provider's models for this step
    const providerModels = PROVIDER_MODELS[forcedProvider][step];
    provider = forcedProvider;
    model = fast ? providerModels.fastModel : providerModels.model;
  } else {
    // Smart routing: pick the best provider/model for this step
    const config = DEFAULT_STEP_CONFIG[step];
    provider = config.provider;
    model = fast ? config.fastModel : config.model;
  }

  return {
    provider,
    model,
    completionFn: getCompletionFnForProvider(provider),
  };
}

/**
 * Get the search mode that should be used based on routing options.
 * When smart routing (no forced provider), defaults to 'gemini' (Google Search grounding).
 * When a provider is forced, uses that provider's search capability.
 */
export function getSearchMode(options: RouterOptions = {}): 'openai' | 'gemini' | 'claude' | 'brave' {
  const { forcedProvider = null } = options;

  if (!forcedProvider) {
    // Smart routing: Gemini Google Search is cheapest (free 500/day)
    return 'gemini';
  }

  // Forced provider: use that provider's search
  switch (forcedProvider) {
    case 'claude': return 'claude';
    case 'gemini': return 'gemini';
    default: return 'openai';
  }
}

/**
 * Get a human-readable summary of the model routing configuration.
 */
export function getRoutingSummary(options: RouterOptions = {}): string {
  const steps: PipelineStep[] = ['identify', 'visual', 'search', 'analyze', 'deliberate', 'reflect'];
  const lines = steps.map(step => {
    const sel = getModelForStep(step, options);
    return `  ${step.padEnd(12)} → ${sel.model} (${sel.provider})`;
  });

  const searchMode = getSearchMode(options);
  lines.push(`  ${'search-api'.padEnd(12)} → ${searchMode} (Google Search grounding)`);

  return `Model Routing${options.forcedProvider ? ` (forced: ${options.forcedProvider})` : ' (smart)'}${options.fast ? ' [FAST]' : ''}:\n${lines.join('\n')}`;
}
