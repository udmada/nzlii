import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("RateLimiterDO", () => {
  it("returns 200 ok for the first request", async () => {
    const id = env.RATE_LIMITER.idFromName("test");
    const stub = env.RATE_LIMITER.get(id);
    const res = await stub.fetch("http://rate-limiter/slot");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 200 for a second immediate request (within lookahead budget)", async () => {
    const id = env.RATE_LIMITER.idFromName("lookahead");
    const stub = env.RATE_LIMITER.get(id);
    const first = await stub.fetch("http://rate-limiter/slot");
    expect(first.status).toBe(200);
    const second = await stub.fetch("http://rate-limiter/slot");
    // Second slot is queued within MAX_LOOKAHEAD_MS so still 200
    expect(second.status).toBe(200);
  });
});
