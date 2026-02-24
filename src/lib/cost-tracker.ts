// ============================================================================
// Cost Tracker — estimates and accumulates API costs per analysis run
// ============================================================================
// Tracks estimated token usage and costs across all AI providers + search APIs.
// Provides per-step, per-analysis, and per-batch cost summaries.
//
// IMPORTANT: These are ESTIMATES based on approximate token counts.
// Actual costs come from provider billing dashboards.

// ---------------------------------------------------------------------------
// Pricing tables (per 1M tokens, February 2026)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  thinkingPerMTok?: number;  // Extended thinking / reasoning tokens
  searchPerCall?: number;     // Per-search-invocation cost
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-5.2':        { inputPerMTok: 1.75, outputPerMTok: 14.00, thinkingPerMTok: 14.00 },
  'gpt-4.1':        { inputPerMTok: 2.00, outputPerMTok: 8.00 },
  'gpt-4.1-mini':   { inputPerMTok: 0.40, outputPerMTok: 1.60 },
  'gpt-4.1-nano':   { inputPerMTok: 0.02, outputPerMTok: 0.15 },
  'gpt-4o-mini':    { inputPerMTok: 0.15, outputPerMTok: 0.60 },

  // Anthropic Claude
  'claude-sonnet-4-5-20250929': { inputPerMTok: 3.00, outputPerMTok: 15.00, thinkingPerMTok: 15.00 },
  'claude-haiku-4-5-20251001':  { inputPerMTok: 1.00, outputPerMTok: 5.00, thinkingPerMTok: 5.00 },

  // Google Gemini
  'gemini-2.5-flash': { inputPerMTok: 0.30, outputPerMTok: 2.50, thinkingPerMTok: 3.50 },
  'gemini-2.5-pro':   { inputPerMTok: 1.25, outputPerMTok: 10.00 },
  'gemini-2.0-flash':  { inputPerMTok: 0.10, outputPerMTok: 0.40 },
};

// Search API costs
const SEARCH_COSTS: Record<string, number> = {
  'openai-web-search':    0.010,  // $10 per 1K searches
  'claude-web-search':    0.010,  // $10 per 1K searches
  'gemini-google-search': 0.035,  // $35 per 1K grounded prompts (paid tier)
  'gemini-google-search-free': 0, // Free tier: 500/day
  'brave-search':         0.005,  // $5 per 1K queries
};

// ---------------------------------------------------------------------------
// Cost entry and tracker
// ---------------------------------------------------------------------------

export interface CostEntry {
  step: string;              // Pipeline step: 'identify', 'search', 'visual', 'analyze', 'deliberate', 'reflect'
  provider: string;          // 'openai' | 'claude' | 'gemini'
  model: string;             // Specific model ID
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedThinkingTokens?: number;
  searchCalls?: number;
  searchType?: string;
  estimatedCost: number;     // Total estimated cost for this call
}

export interface CostSummary {
  entries: CostEntry[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSearchCalls: number;
  byStep: Record<string, number>;
  byProvider: Record<string, number>;
  // Comparison with old pricing (GPT-5.2 + OpenAI search for everything)
  legacyCostEstimate: number;
  savings: number;
  savingsPercent: number;
}

export class CostTracker {
  private entries: CostEntry[] = [];

  /**
   * Record an API call with estimated token counts.
   * Token counts are estimates based on prompt length — actual usage comes from billing.
   */
  add(entry: Omit<CostEntry, 'estimatedCost'>): void {
    const pricing = MODEL_PRICING[entry.model];
    if (!pricing) {
      // Unknown model — log but don't crash
      console.warn(`[cost-tracker] Unknown model pricing: ${entry.model}`);
      this.entries.push({ ...entry, estimatedCost: 0 });
      return;
    }

    let cost = 0;

    // Token costs
    cost += (entry.estimatedInputTokens / 1_000_000) * pricing.inputPerMTok;
    cost += (entry.estimatedOutputTokens / 1_000_000) * pricing.outputPerMTok;

    // Thinking token costs (if applicable)
    if (entry.estimatedThinkingTokens && pricing.thinkingPerMTok) {
      cost += (entry.estimatedThinkingTokens / 1_000_000) * pricing.thinkingPerMTok;
    }

    // Search costs
    if (entry.searchCalls && entry.searchType) {
      const searchCost = SEARCH_COSTS[entry.searchType] || 0;
      cost += entry.searchCalls * searchCost;
    }

    this.entries.push({ ...entry, estimatedCost: cost });
  }

  /**
   * Estimate what this same workload would cost under the OLD model configuration
   * (GPT-5.2 for everything, OpenAI web search).
   */
  private estimateLegacyCost(): number {
    const gpt52 = MODEL_PRICING['gpt-5.2']!;
    let legacy = 0;

    for (const entry of this.entries) {
      // All LLM calls would have used GPT-5.2
      legacy += (entry.estimatedInputTokens / 1_000_000) * gpt52.inputPerMTok;
      legacy += (entry.estimatedOutputTokens / 1_000_000) * gpt52.outputPerMTok;

      // Thinking tokens at GPT-5.2 rate
      if (entry.estimatedThinkingTokens) {
        legacy += (entry.estimatedThinkingTokens / 1_000_000) * gpt52.outputPerMTok;
      }

      // Search would have used OpenAI web search
      if (entry.searchCalls) {
        legacy += entry.searchCalls * SEARCH_COSTS['openai-web-search'];
      }
    }

    return legacy;
  }

  /**
   * Get a full cost summary with breakdowns and savings comparison.
   */
  getSummary(): CostSummary {
    const byStep: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalSearchCalls = 0;
    let totalCost = 0;

    for (const entry of this.entries) {
      totalCost += entry.estimatedCost;
      totalInputTokens += entry.estimatedInputTokens;
      totalOutputTokens += entry.estimatedOutputTokens;
      totalSearchCalls += entry.searchCalls || 0;

      byStep[entry.step] = (byStep[entry.step] || 0) + entry.estimatedCost;
      byProvider[entry.provider] = (byProvider[entry.provider] || 0) + entry.estimatedCost;
    }

    const legacyCostEstimate = this.estimateLegacyCost();
    const savings = legacyCostEstimate - totalCost;
    const savingsPercent = legacyCostEstimate > 0 ? (savings / legacyCostEstimate) * 100 : 0;

    return {
      entries: this.entries,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalSearchCalls,
      byStep,
      byProvider,
      legacyCostEstimate,
      savings,
      savingsPercent,
    };
  }

  /**
   * Format a human-readable cost report.
   */
  formatReport(): string {
    const s = this.getSummary();
    const lines: string[] = [
      '┌─────────────────────────────────────────────────────────┐',
      '│                    COST SUMMARY                        │',
      '├─────────────────────────────────────────────────────────┤',
      `│  Estimated Cost:     $${s.totalCost.toFixed(4).padStart(10)}                       │`,
      `│  Legacy Cost (GPT-5.2): $${s.legacyCostEstimate.toFixed(4).padStart(10)}                    │`,
      `│  Savings:            $${s.savings.toFixed(4).padStart(10)} (${s.savingsPercent.toFixed(0)}%)${' '.repeat(Math.max(0, 17 - s.savingsPercent.toFixed(0).length))}│`,
      '├─────────────────────────────────────────────────────────┤',
      `│  Input Tokens:       ${s.totalInputTokens.toLocaleString().padStart(10)}                       │`,
      `│  Output Tokens:      ${s.totalOutputTokens.toLocaleString().padStart(10)}                       │`,
      `│  Search Calls:       ${String(s.totalSearchCalls).padStart(10)}                       │`,
      '├─────────────────────────────────────────────────────────┤',
    ];

    // By step
    lines.push('│  Cost by Step:                                          │');
    for (const [step, cost] of Object.entries(s.byStep)) {
      lines.push(`│    ${step.padEnd(20)} $${cost.toFixed(4).padStart(10)}                    │`);
    }

    // By provider
    lines.push('├─────────────────────────────────────────────────────────┤');
    lines.push('│  Cost by Provider:                                      │');
    for (const [provider, cost] of Object.entries(s.byProvider)) {
      lines.push(`│    ${provider.padEnd(20)} $${cost.toFixed(4).padStart(10)}                    │`);
    }

    lines.push('└─────────────────────────────────────────────────────────┘');
    return lines.join('\n');
  }

  /** Reset for a new analysis run */
  reset(): void {
    this.entries = [];
  }

  /** Merge entries from another tracker (for batch accumulation) */
  merge(other: CostTracker): void {
    this.entries.push(...other.entries);
  }
}

// ---------------------------------------------------------------------------
// Singleton for batch-level cost accumulation
// ---------------------------------------------------------------------------
let batchTracker: CostTracker | null = null;

export function getBatchCostTracker(): CostTracker {
  if (!batchTracker) {
    batchTracker = new CostTracker();
  }
  return batchTracker;
}

export function resetBatchCostTracker(): void {
  batchTracker = new CostTracker();
}

// ---------------------------------------------------------------------------
// Token estimation helpers (rough estimates based on text length)
// ---------------------------------------------------------------------------

/** Estimate tokens from text length (~4 chars per token for English) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a set of chat messages */
export function estimateMessageTokens(messages: Array<{ content: string | unknown[] }>): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          total += estimateTokens((part as { text: string }).text || '');
        }
        // Images add ~765 tokens for high detail
        if (typeof part === 'object' && part !== null && 'image_url' in part) {
          total += 765;
        }
      }
    }
  }
  return total;
}
