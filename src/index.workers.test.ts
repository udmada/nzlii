import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("GET /courts", () => {
  it("returns JSON array", async () => {
    const res = await SELF.fetch("http://example.com/courts");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const data: unknown = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("GET /decisions", () => {
  it("returns 400 when court and year are missing", async () => {
    const res = await SELF.fetch("http://example.com/decisions");
    expect(res.status).toBe(400);
  });

  it("returns 400 when year is invalid", async () => {
    const res = await SELF.fetch("http://example.com/decisions?court=NZSC&year=abc");
    expect(res.status).toBe(400);
  });

  it("returns non-400 with valid court and year params", async () => {
    const res = await SELF.fetch("http://example.com/decisions?court=NZSC&year=2020");
    // D1 has no schema in test env → 500; in production → 200. Just verify param validation passes.
    expect(res.status).not.toBe(400);
  });
});

describe("GET /decisions/:court/:year/:num", () => {
  it("returns non-400 for well-formed path", async () => {
    const res = await SELF.fetch("http://example.com/decisions/NZSC/2020/99");
    // D1 has no schema in test env → 500; production would be 404 for missing row
    expect(res.status).not.toBe(400);
  });
});

describe("POST /requeue-pending", () => {
  it("returns non-404 for POST (route is recognised)", async () => {
    const res = await SELF.fetch("http://example.com/requeue-pending", { method: "POST" });
    // D1 has no schema in test env → likely 500; production → 200 JSON.
    // Either way the route must be matched (not 404).
    expect(res.status).not.toBe(404);
  });

  it("returns 404 for GET (no GET handler)", async () => {
    const res = await SELF.fetch("http://example.com/requeue-pending");
    expect(res.status).toBe(404);
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const res = await SELF.fetch("http://example.com/unknown");
    expect(res.status).toBe(404);
  });
});
