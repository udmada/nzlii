import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getCourts, saveCourts, isYearDone, markYearDone, getDoneYears } from "./kv.ts";

const makeKV = (store: Record<string, string> = {}) => ({
  store,
  get: async (key: string, _type?: string) => {
    const val = store[key];
    if (val === undefined) return null;
    if (_type === "json") return JSON.parse(val) as unknown;
    return val;
  },
  put: async (key: string, value: string) => {
    store[key] = value;
  },
  delete: async (key: string) => {
    delete store[key];
  },
  list: async ({ prefix }: { prefix?: string } = {}) => ({
    keys: Object.keys(store)
      .filter((k) => prefix == null || k.startsWith(prefix))
      .map((k) => ({ name: k })),
    list_complete: true,
    cursor: "",
  }),
  getWithMetadata: async (key: string) => ({ value: store[key] ?? null, metadata: null }),
});

void describe("getCourts", () => {
  void it("returns null when no cache exists", async () => {
    const kv = makeKV();
    assert.equal(await getCourts(kv as never), null);
  });

  void it("returns null when cache is expired (> 7 days)", async () => {
    const kv = makeKV({
      courts: JSON.stringify({ fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, courts: [] }),
    });
    assert.equal(await getCourts(kv as never), null);
  });

  void it("returns courts when cache is fresh", async () => {
    const courts = [{ code: "NZSC", name: "Supreme Court" }];
    const kv = makeKV({
      courts: JSON.stringify({ fetchedAt: Date.now(), courts }),
    });
    assert.deepEqual(await getCourts(kv as never), courts);
  });

  void it("returns null when cached data has wrong shape", async () => {
    const kv = makeKV({ courts: JSON.stringify({ wrong: "shape" }) });
    assert.equal(await getCourts(kv as never), null);
  });
});

void describe("saveCourts", () => {
  void it("writes courts with current timestamp", async () => {
    const kv = makeKV();
    const courts = [{ code: "NZSC", name: "Supreme Court" }];
    await saveCourts(kv as never, courts);
    const raw = kv.store["courts"];
    assert.ok(raw);
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.courts, courts);
    assert.ok(typeof parsed.fetchedAt === "number");
    assert.ok(Date.now() - parsed.fetchedAt < 1000);
  });
});

void describe("isYearDone / markYearDone", () => {
  void it("returns false when not marked", async () => {
    const kv = makeKV();
    assert.equal(await isYearDone(kv as never, "NZSC", 2020), false);
  });

  void it("returns true after marking done", async () => {
    const kv = makeKV();
    await markYearDone(kv as never, "NZSC", 2020);
    assert.equal(await isYearDone(kv as never, "NZSC", 2020), true);
  });

  void it("keys are scoped by court and year", async () => {
    const kv = makeKV();
    await markYearDone(kv as never, "NZSC", 2020);
    assert.equal(await isYearDone(kv as never, "NZCA", 2020), false);
    assert.equal(await isYearDone(kv as never, "NZSC", 2021), false);
  });
});

void describe("getDoneYears", () => {
  void it("returns empty set when no years are done", async () => {
    const kv = makeKV();
    const result = await getDoneYears(kv as never, "NZSC");
    assert.equal(result.size, 0);
  });

  void it("returns correct years for a court", async () => {
    const kv = makeKV();
    await markYearDone(kv as never, "NZSC", 2020);
    await markYearDone(kv as never, "NZSC", 2021);
    await markYearDone(kv as never, "NZSC", 2022);
    const result = await getDoneYears(kv as never, "NZSC");
    assert.equal(result.size, 3);
    assert.ok(result.has(2020));
    assert.ok(result.has(2021));
    assert.ok(result.has(2022));
  });

  void it("does not include years from other courts", async () => {
    const kv = makeKV();
    await markYearDone(kv as never, "NZSC", 2020);
    await markYearDone(kv as never, "NZCA", 2020);
    const nzsc = await getDoneYears(kv as never, "NZSC");
    assert.equal(nzsc.size, 1);
    assert.ok(nzsc.has(2020));
    const nzca = await getDoneYears(kv as never, "NZCA");
    assert.equal(nzca.size, 1);
    assert.ok(nzca.has(2020));
  });
});
