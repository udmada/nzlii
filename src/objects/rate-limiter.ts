import { DurableObject } from "cloudflare:workers";

const MIN_FETCH_GAP_MS = 800;
const FETCH_JITTER_MS = 2000;
// If the queue is so backed up that the next available slot is more than this
// far ahead, return 503 rather than blocking the Worker for minutes.
const MAX_LOOKAHEAD_MS = 8_000;

/**
 * Single global Durable Object instance that enforces a polite request gap
 * to nzlii.org across all concurrent Queue Consumer Worker instances.
 *
 * Exposes an RPC method:
 *   acquireSlot() → true   — slot acquired, caller may proceed
 *   acquireSlot() → false  — backlog too deep, caller should re-enqueue with delay
 *
 * Slots are reserved synchronously before any await, guaranteeing no two
 * callers claim the same slot (Durable Objects are single-threaded).
 */
export class RateLimiterDO extends DurableObject {
  private nextFetchMs = 0;

  async acquireSlot(): Promise<boolean> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextFetchMs);
    const wait = startAt - now;
    if (wait > MAX_LOOKAHEAD_MS) return false;
    this.nextFetchMs = startAt + MIN_FETCH_GAP_MS + Math.random() * FETCH_JITTER_MS;
    if (wait > 0) await scheduler.wait(wait);
    return true;
  }
}
