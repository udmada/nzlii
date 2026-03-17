import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Effect } from "effect";

import {
  upsertCase,
  upsertCaseBatch,
  markDone,
  markError,
  queryCases,
  queryPendingCases,
} from "./d1.ts";

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
      if (sql.includes("status IN")) {
        const statuses = bindings as string[];
        return { results: rows.filter((r) => statuses.includes(r.status)) };
      }
      const [court, year] = bindings as [string, number];
      return { results: rows.filter((r) => r.court === court && r.year === year) };
    },
  });
  return {
    rows,
    prepare: (sql: string) => ({ bind: (...b: unknown[]) => makeStmt(sql, b) }),
    batch: async (stmts: Array<{ run(): Promise<unknown> }>) => {
      for (const stmt of stmts) await stmt.run();
      return [];
    },
  };
};

const makeFailingD1 = () => ({
  prepare: (_sql: string) => ({
    bind: (..._b: unknown[]) => ({
      run: async () => {
        throw new Error("DB failure");
      },
      all: async () => {
        throw new Error("DB failure");
      },
    }),
  }),
  batch: async (_stmts: unknown[]) => {
    throw new Error("DB failure");
  },
});

void describe("upsertCase", () => {
  void it("inserts a new case with pending status", async () => {
    const db = makeD1();
    await Effect.runPromise(
      upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "http://example.com/1.html"),
    );
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0]?.status, "pending");
  });

  void it("does not duplicate on second insert", async () => {
    const db = makeD1();
    await Effect.runPromise(
      upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "http://example.com/1.html"),
    );
    await Effect.runPromise(
      upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "http://example.com/1.html"),
    );
    assert.equal(db.rows.length, 1);
  });
});

void describe("upsertCaseBatch", () => {
  void it("inserts multiple cases in a single batch", async () => {
    const db = makeD1();
    await Effect.runPromise(
      upsertCaseBatch(db as never, "NZHC", 2025, [
        { num: "1", title: "A v B", url: "http://example.com/1.html" },
        { num: "2", title: "C v D", url: "http://example.com/2.html" },
        { num: "3", title: "E v F", url: "http://example.com/3.html" },
      ]),
    );
    assert.equal(db.rows.length, 3);
    assert.ok(db.rows.every((r) => r.status === "pending" && r.court === "NZHC"));
  });

  void it("does not duplicate on repeated batch", async () => {
    const db = makeD1();
    const cases = [{ num: "1", title: "A v B", url: "http://example.com/1.html" }];
    await Effect.runPromise(upsertCaseBatch(db as never, "NZHC", 2025, cases));
    await Effect.runPromise(upsertCaseBatch(db as never, "NZHC", 2025, cases));
    assert.equal(db.rows.length, 1);
  });

  void it("handles empty case list without error", async () => {
    const db = makeD1();
    await Effect.runPromise(upsertCaseBatch(db as never, "NZHC", 2025, []));
    assert.equal(db.rows.length, 0);
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

void describe("queryPendingCases", () => {
  const makeRows = () => [
    {
      court: "NZSC",
      year: 2026,
      num: "1",
      title: "Smith v Jones",
      url: "http://example.com/1.html",
      status: "pending",
      r2_key: null,
      error: null,
      scraped_at: null,
    },
    {
      court: "NZSC",
      year: 2026,
      num: "2",
      title: "Re Trust",
      url: "http://example.com/2.html",
      status: "error",
      r2_key: null,
      error: "HTTP 526",
      scraped_at: null,
    },
    {
      court: "NZCA",
      year: 2025,
      num: "3",
      title: "Crown v Doe",
      url: "http://example.com/3.html",
      status: "done",
      r2_key: "NZCA/2025/3 - Crown v Doe.txt",
      error: null,
      scraped_at: 1_000_000,
    },
  ];

  void it("returns only pending rows when status=[pending]", async () => {
    const db = makeD1(makeRows());
    const results = await Effect.runPromise(queryPendingCases(db as never, ["pending"]));
    assert.equal(results.length, 1);
    assert.equal(results[0]?.num, "1");
    assert.equal(results[0]?.court, "NZSC");
  });

  void it("returns pending and error rows when status=[pending,error]", async () => {
    const db = makeD1(makeRows());
    const results = await Effect.runPromise(queryPendingCases(db as never, ["pending", "error"]));
    assert.equal(results.length, 2);
  });

  void it("returns empty array when no rows match", async () => {
    const db = makeD1(); // empty store
    const results = await Effect.runPromise(queryPendingCases(db as never, ["pending"]));
    assert.equal(results.length, 0);
  });
});

void describe("error paths", () => {
  void it("upsertCaseBatch propagates StorageError on DB failure", async () => {
    const db = makeFailingD1();
    const result = await Effect.runPromise(
      Effect.either(
        upsertCaseBatch(db as never, "NZHC", 2025, [{ num: "1", title: "A", url: "http://x.com" }]),
      ),
    );
    assert.equal(result._tag, "Left");
    assert.equal(result.left._tag, "StorageError");
  });

  void it("upsertCase propagates StorageError on DB failure", async () => {
    const db = makeFailingD1();
    const result = await Effect.runPromise(
      Effect.either(upsertCase(db as never, "NZSC", 2026, "1", "t", "http://x.com")),
    );
    assert.equal(result._tag, "Left");
    assert.equal(result.left._tag, "StorageError");
  });

  void it("markDone propagates StorageError on DB failure", async () => {
    const db = makeFailingD1();
    const result = await Effect.runPromise(
      Effect.either(markDone(db as never, "NZSC", 2026, "1", "key" as never)),
    );
    assert.equal(result._tag, "Left");
    assert.equal(result.left._tag, "StorageError");
  });

  void it("markError propagates StorageError on DB failure", async () => {
    const db = makeFailingD1();
    const result = await Effect.runPromise(
      Effect.either(markError(db as never, "NZSC", 2026, "1", "timeout")),
    );
    assert.equal(result._tag, "Left");
    assert.equal(result.left._tag, "StorageError");
  });

  void it("queryCases propagates StorageError on DB failure", async () => {
    const db = makeFailingD1();
    const result = await Effect.runPromise(Effect.either(queryCases(db as never, "NZSC", 2026)));
    assert.equal(result._tag, "Left");
    assert.equal(result.left._tag, "StorageError");
  });

  void it("queryPendingCases propagates StorageError on DB failure", async () => {
    const db = makeFailingD1();
    const result = await Effect.runPromise(
      Effect.either(queryPendingCases(db as never, ["pending"])),
    );
    assert.equal(result._tag, "Left");
    assert.equal(result.left._tag, "StorageError");
  });
});
