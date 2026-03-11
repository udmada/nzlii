import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Effect } from "effect";

import { upsertCase, markDone, markError, queryCases } from "./d1.ts";

type Row = {
  court: string;
  year: number;
  num: string;
  title: string;
  url: string;
  status: string;
  r2_key: string | null;
  error: string | null;
  scraped_at: number | null;
};

const makeD1 = (rows: Row[] = []) => {
  const makeStmt = (sql: string, bindings: readonly unknown[]) => ({
    run: async () => {
      if (sql.includes("INSERT INTO cases")) {
        const [court, year, num, title, url] = bindings as [string, number, string, string, string];
        const exists = rows.some((r) => r.court === court && r.year === year && r.num === num);
        if (!exists)
          rows.push({
            court,
            year,
            num,
            title,
            url,
            status: "pending",
            r2_key: null,
            error: null,
            scraped_at: null,
          });
      } else if (sql.includes("SET status")) {
        // distinguish done vs error by which fields are bound
        if (sql.includes("r2_key")) {
          const [status, r2_key, scraped_at, court, year, num] = bindings as [
            string,
            string,
            number,
            string,
            number,
            string,
          ];
          const row = rows.find((r) => r.court === court && r.year === year && r.num === num);
          if (row) Object.assign(row, { status, r2_key, scraped_at });
        } else {
          const [status, error, scraped_at, court, year, num] = bindings as [
            string,
            string,
            number,
            string,
            number,
            string,
          ];
          const row = rows.find((r) => r.court === court && r.year === year && r.num === num);
          if (row) Object.assign(row, { status, error, scraped_at });
        }
      }
    },
    all: async () => {
      const [court, year] = bindings as [string, number];
      return { results: rows.filter((r) => r.court === court && r.year === year) };
    },
  });
  return {
    rows,
    prepare: (sql: string) => ({ bind: (...b: unknown[]) => makeStmt(sql, b) }),
  };
};

void describe("upsertCase", () => {
  void it("inserts a new case with pending status", async () => {
    const db = makeD1();
    await Effect.runPromise(
      upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "https://example.com/1.html"),
    );
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0]?.status, "pending");
  });

  void it("does not duplicate on second insert", async () => {
    const db = makeD1();
    await Effect.runPromise(
      upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "https://example.com/1.html"),
    );
    await Effect.runPromise(
      upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "https://example.com/1.html"),
    );
    assert.equal(db.rows.length, 1);
  });
});

void describe("markDone", () => {
  void it("sets status to done and records r2_key", async () => {
    const db = makeD1([
      {
        court: "NZSC",
        year: 2026,
        num: "1",
        title: "Smith v Jones",
        url: "",
        status: "pending",
        r2_key: null,
        error: null,
        scraped_at: null,
      },
    ]);
    await Effect.runPromise(
      markDone(db as never, "NZSC", 2026, "1", "NZSC/2026/1 - Smith v Jones.txt" as never),
    );
    assert.equal(db.rows[0]?.status, "done");
    assert.equal(db.rows[0]?.r2_key, "NZSC/2026/1 - Smith v Jones.txt");
  });
});

void describe("markError", () => {
  void it("sets status to error and records message", async () => {
    const db = makeD1([
      {
        court: "NZSC",
        year: 2026,
        num: "1",
        title: "Smith v Jones",
        url: "",
        status: "pending",
        r2_key: null,
        error: null,
        scraped_at: null,
      },
    ]);
    await Effect.runPromise(markError(db as never, "NZSC", 2026, "1", "HTTP 404"));
    assert.equal(db.rows[0]?.status, "error");
    assert.equal(db.rows[0]?.error, "HTTP 404");
  });
});

void describe("queryCases", () => {
  void it("returns cases filtered by court and year", async () => {
    const db = makeD1([
      {
        court: "NZSC",
        year: 2026,
        num: "1",
        title: "t",
        url: "",
        status: "done",
        r2_key: "k",
        error: null,
        scraped_at: null,
      },
      {
        court: "NZCA",
        year: 2026,
        num: "2",
        title: "t",
        url: "",
        status: "done",
        r2_key: "k",
        error: null,
        scraped_at: null,
      },
    ]);
    const results = await Effect.runPromise(queryCases(db as never, "NZSC", 2026));
    assert.equal(results.length, 1);
  });

  void it("returns empty array when no cases exist", async () => {
    const db = makeD1();
    const results = await Effect.runPromise(queryCases(db as never, "NZSC", 2026));
    assert.equal(results.length, 0);
  });
});
