// Concurrent rate limiter with semaphore pattern
// Allows N requests in-flight simultaneously while respecting per-minute limits
// Previous version was a serial queue (processed one request at a time),
// which was the main bottleneck for batch processing.

class ConcurrentRateLimiter {
  private activeCount = 0;
  private maxConcurrent: number;
  private pendingResolvers: (() => void)[] = [];
  private requestTimestamps: number[] = [];
  private maxPerMinute: number;
  private name: string;

  constructor(name: string, options: {
    maxConcurrent?: number;
    maxPerMinute?: number;
  }) {
    this.name = name;
    this.maxConcurrent = options.maxConcurrent || 50;
    this.maxPerMinute = options.maxPerMinute || 500;
  }

  async execute<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    await this.acquire();
    try {
      return await this.executeWithRetry(fn, maxRetries);
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    // Wait for a concurrent slot (semaphore)
    while (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>(resolve => {
        this.pendingResolvers.push(resolve);
      });
    }

    // Per-minute rate limiting (sliding window)
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => t > now - 60000);

    while (this.requestTimestamps.length >= this.maxPerMinute) {
      const oldestInWindow = this.requestTimestamps[0];
      const waitTime = 60000 - (now - oldestInWindow) + 100;
      if (waitTime > 0) {
        console.log(`[${this.name}] Per-minute limit reached (${this.requestTimestamps.length}/${this.maxPerMinute}), waiting ${Math.round(waitTime / 1000)}s`);
        await new Promise(r => setTimeout(r, waitTime));
      }
      const freshNow = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(t => t > freshNow - 60000);
    }

    this.activeCount++;
    this.requestTimestamps.push(Date.now());
  }

  private release(): void {
    this.activeCount--;
    if (this.pendingResolvers.length > 0) {
      const next = this.pendingResolvers.shift()!;
      next();
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
    let lastError: Error = new Error('Unknown error');
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const msg = lastError.message.toLowerCase();
        if (msg.includes('429') || msg.includes('rate_limited') || msg.includes('rate limit')) {
          if (attempt < maxRetries) {
            const backoff = Math.pow(2, attempt + 1) * 1000;
            console.log(`[${this.name}] Rate limited, retry ${attempt + 1}/${maxRetries} after ${backoff}ms`);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  getQueueLength(): number {
    return this.pendingResolvers.length;
  }

  getActiveCount(): number {
    return this.activeCount;
  }
}

// Singleton instances for different services
// OpenAI: high concurrency — each request takes 5-60s, API supports thousands RPM on paid tiers
export const openaiRateLimiter = new ConcurrentRateLimiter('openai', {
  maxConcurrent: 150,
  maxPerMinute: 500,
});

// Shopify: moderate concurrency — REST API has bucket rate limiting (~40 req/s)
export const shopifyRateLimiter = new ConcurrentRateLimiter('shopify', {
  maxConcurrent: 20,
  maxPerMinute: 80,
});

// Brave: low concurrency — free tier is very limited
export const braveRateLimiter = new ConcurrentRateLimiter('brave', {
  maxConcurrent: 5,
  maxPerMinute: 15,
});
