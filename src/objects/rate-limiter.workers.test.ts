import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("RateLimiterDO", () => {
  it("acquireSlot returns true for the first request", async () => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("test"));
    expect(await stub.acquireSlot()).toBe(true);
  });

  it("acquireSlot returns true for a second immediate request (within lookahead budget)", async () => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("lookahead"));
    expect(await stub.acquireSlot()).toBe(true);
    // Second slot is queued within MAX_LOOKAHEAD_MS so still true
    expect(await stub.acquireSlot()).toBe(true);
  });
});
