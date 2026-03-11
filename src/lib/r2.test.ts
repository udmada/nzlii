import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headObject, putText, putBinary, makeR2Key } from "./r2.ts";

const makeR2 = () => {
  const store = new Map<string, { data: string | ArrayBuffer; contentType: string }>();
  return {
    store,
    head: async (key: string) => (store.has(key) ? { key } : null),
    put: async (
      key: string,
      data: string | ArrayBuffer,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      store.set(key, { data, contentType: opts?.httpMetadata?.contentType ?? "" });
      return null;
    },
    get: async (key: string) => {
      const entry = store.get(key);
      return entry ? { body: entry.data } : null;
    },
  };
};

void describe("headObject", () => {
  void it("returns false when object does not exist", async () => {
    const r2 = makeR2();
    assert.equal(await headObject(r2 as never, "NZSC/2026/1 - Smith v Jones.txt" as never), false);
  });

  void it("returns true when object exists", async () => {
    const r2 = makeR2();
    await r2.put("key", "data");
    assert.equal(await headObject(r2 as never, "key" as never), true);
  });
});

void describe("putText", () => {
  void it("stores text with correct content type", async () => {
    const r2 = makeR2();
    await putText(r2 as never, "key.txt" as never, "hello");
    assert.equal(r2.store.get("key.txt")?.contentType, "text/plain; charset=utf-8");
    assert.equal(r2.store.get("key.txt")?.data, "hello");
  });
});

void describe("putBinary", () => {
  void it("stores binary with PDF content type", async () => {
    const r2 = makeR2();
    const buf = new ArrayBuffer(4);
    await putBinary(r2 as never, "key.pdf" as never, buf);
    assert.equal(r2.store.get("key.pdf")?.contentType, "application/pdf");
  });
});

void describe("makeR2Key", () => {
  void it("formats key correctly for txt", () => {
    const key = makeR2Key("NZSC", 2026, "1", "Smith v Jones", "txt");
    assert.equal(key, "NZSC/2026/1 - Smith v Jones.txt");
  });

  void it("formats key correctly for pdf", () => {
    const key = makeR2Key("NZHC", 2020, "42", "Re Application", "pdf");
    assert.equal(key, "NZHC/2020/42 - Re Application.pdf");
  });
});
