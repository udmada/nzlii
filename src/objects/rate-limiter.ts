import { DurableObject } from "cloudflare:workers";

const MIN_FETCH_GAP_MS = 800;
const FETCH_JITTER_MS = 2000;

/**
 * Single global Durable Object instance that enforces a polite request gap
 * to nzlii.org across all concurrent Queue Consumer Worker instances.
 *
 * Slots are reserved synchronously before any await, guaranteeing no two
 * callers claim the same slot (Durable Objects are single-threaded).
 */
export class RateLimiterDO extends DurableObject {
  private nextFetchMs = 0;

  async waitForSlot(): Promise<void> {
    const startAt = Math.max(Date.now(), this.nextFetchMs);
    this.nextFetchMs = startAt + MIN_FETCH_GAP_MS + Math.random() * FETCH_JITTER_MS;
    const wait = startAt - Date.now();
    if (wait > 0) await scheduler.wait(wait);
  }
}
