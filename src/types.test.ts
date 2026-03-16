import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchError, parseError, storageError, toErrorMessage, toScraperError } from "./types.ts";

void describe("fetchError", () => {
  void it("creates FetchError with correct shape", () => {
    const e = fetchError(404, "http://example.com");
    assert.equal(e._tag, "FetchError");
    assert.equal(e.status, 404);
    assert.equal(e.url, "http://example.com");
  });
});

void describe("parseError", () => {
  void it("creates ParseError with correct shape", () => {
    const e = parseError("bad data");
    assert.equal(e._tag, "ParseError");
    assert.equal(e.message, "bad data");
  });
});

void describe("storageError", () => {
  void it("creates StorageError with correct shape", () => {
    const e = storageError("disk full");
    assert.equal(e._tag, "StorageError");
    assert.equal(e.message, "disk full");
  });
});

void describe("toErrorMessage", () => {
  void it("extracts message from Error instances", () => {
    assert.equal(toErrorMessage(new Error("oops")), "oops");
  });

  void it("converts non-Error values to string", () => {
    assert.equal(toErrorMessage("raw string"), "raw string");
    assert.equal(toErrorMessage(42), "42");
  });
});

void describe("toScraperError", () => {
  void it("wraps Error in ParseError", () => {
    const e = toScraperError(new Error("fail"));
    assert.equal(e._tag, "ParseError");
    assert.equal(e.message, "fail");
  });

  void it("wraps non-Error in ParseError with string conversion", () => {
    const e = toScraperError("something went wrong");
    assert.equal(e._tag, "ParseError");
    assert.equal(e.message, "something went wrong");
  });
});
