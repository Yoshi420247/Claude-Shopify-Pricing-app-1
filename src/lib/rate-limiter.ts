// Smart rate limiter with exponential backoff and request queuing

interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retries: number;
  maxRetries: number;
}

class RateLimiter {
  private queue: QueuedRequest<unknown>[] = [];
  private processing = false;
  private lastRequestTime = 0;
  private minInterval: number; // ms between requests
  private requestCount = 0;
  private windowStart = Date.now();
  private maxPerWindow: number;
  private windowSize: number; // ms

  constructor(options: {
    requestsPerSecond?: number;
    maxPerMinute?: number;
  } = {}) {
    this.minInterval = 1000 / (options.requestsPerSecond || 1);
    this.maxPerWindow = options.maxPerMinute || 15;
    this.windowSize = 60000; // 1 minute
  }

  async execute<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        execute: fn,
        resolve: resolve as (value: unknown) => void,
        reject,
        retries: 0,
        maxRetries,
      });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      // Check window rate limit
      const now = Date.now();
      if (now - this.windowStart > this.windowSize) {
        this.windowStart = now;
        this.requestCount = 0;
      }

      if (this.requestCount >= this.maxPerWindow) {
        const waitTime = this.windowSize - (now - this.windowStart) + 100;
        console.log(`Rate limit: waiting ${Math.round(waitTime / 1000)}s for window reset`);
        await this.sleep(waitTime);
        continue;
      }

      // Check per-request rate limit
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minInterval) {
        await this.sleep(this.minInterval - timeSinceLastRequest);
      }

      const request = this.queue.shift()!;
      this.lastRequestTime = Date.now();
      this.requestCount++;

      try {
        const result = await request.execute();
        request.resolve(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if rate limited
        if (errorMessage.includes('429') || errorMessage.includes('RATE_LIMITED')) {
          request.retries++;
          if (request.retries <= request.maxRetries) {
            // Exponential backoff: 2s, 4s, 8s, 16s
            const backoff = Math.pow(2, request.retries) * 1000;
            console.log(`Rate limited, retry ${request.retries}/${request.maxRetries} after ${backoff}ms`);
            await this.sleep(backoff);
            this.queue.unshift(request); // Put back at front of queue
          } else {
            request.reject(new Error(`Rate limited after ${request.maxRetries} retries`));
          }
        } else {
          request.reject(error instanceof Error ? error : new Error(errorMessage));
        }
      }
    }

    this.processing = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

// Singleton instances for different services
export const braveRateLimiter = new RateLimiter({
  requestsPerSecond: 0.5, // 1 request per 2 seconds (conservative)
  maxPerMinute: 15, // Stay well under the limit
});

export const openaiRateLimiter = new RateLimiter({
  requestsPerSecond: 5,
  maxPerMinute: 200,
});
