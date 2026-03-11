# Cloudflare Port Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the NZ legal decision scraper to Cloudflare Workers — scheduled, backfilling 2000→present, with Workflows for orchestration, Queues for per-case fan-out, a DO rate limiter, R2 for files, KV for caching/flags, and D1 for queryable metadata.

**Architecture:** A daily Cron fires `OrchestratorWorkflow` which spawns one `CourtScrapeWorkflow` per court×year (recent-first, skipping KV-flagged completed years). Each `CourtScrapeWorkflow` fetches the index, upserts cases into D1, and enqueues one Queue message per case. A Queue Consumer Worker processes each message: calls `RateLimiterDO` for a global token-bucket delay, fetches the decision, writes to R2, and updates D1.

**Tech Stack:** TypeScript 7.0, Cloudflare Workers + Workflows + Queues + DO + KV + R2 + D1, wrangler (latest), pnpm, Node LTS via mise, oxlint (type-aware), oxfmt, node:test, Effect (optional, where it brings clarity)

---

## Code Style (apply throughout every task)

These rules override any conflicting examples in the task bodies below.

### Functional programming first

- Pure functions everywhere possible — no side effects except at the explicit I/O boundary (KV/R2/D1/fetch calls)
- `const` arrow functions, not `function` declarations
- Prefer `map`, `flatMap`, `filter`, `reduce` over imperative loops
- Compose with `pipe()` from Effect when chaining multiple transformations
- Immutable data: `readonly` on all object types, `as const` for literal objects

### Effect library

- `effect` is a runtime dependency — add it in Task 1 (`pnpm add effect`)
- Use `Effect<A, E, R>` for operations that can fail with typed errors instead of `Result<T>` where the extra type-safety is worth it
- Use `Effect.tryPromise`, `Effect.map`, `Effect.flatMap`, `Effect.pipe`
- Use `Schema` from `effect` for runtime validation instead of hand-rolled TypeGuards where practical
- Do NOT use Effect if it adds boilerplate without clarity gain — the `Result<T>` pattern is still fine for simple cases

### Type system

- Use generics liberally — prefer `<T extends Record<string, unknown>>` over `object` or `unknown` where the shape is partially known
- Branded types for IDs and keys where confusion is possible (e.g. `type R2Key = string & { readonly _brand: "R2Key" }`)
- Discriminated unions over boolean flags
- `satisfies` operator to validate literal objects against interfaces without widening
- No `any` — use `unknown` + narrowing or `never` as appropriate
- No force type casting (`as SomeType`) — use type guards, `satisfies`, or `Effect.Schema.decode`

### No runtime casting exceptions

- `as never` is allowed only in exhaustiveness checks (`satisfies never`)
- `as unknown as T` is forbidden — if you need this, your types are wrong
- `// @ts-expect-error` requires a comment explaining why it's unavoidable

---

## Task 1: Scaffold

**Files:**

- Create: `src/types.ts`
- Create: `schema.sql`
- Create: `wrangler.toml`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `mise.toml`

**Step 1: Add dependencies**

```bash
pnpm add effect
pnpm add -D wrangler @cloudflare/workers-types
```

`effect` is a runtime dependency (bundled by wrangler). `wrangler` and `@cloudflare/workers-types` are dev-only.

Expected: both appear in `package.json` devDependencies.

**Step 2: Update `tsconfig.json`**

Add the workers-types lib and a separate `src/` include so wrangler can type-check Workers code. Keep existing config for `scrape.ts`.

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "scrape.ts", "scrape.test.ts"]
}
```

**Step 3: Create `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS cases (
  court      TEXT    NOT NULL,
  year       INTEGER NOT NULL,
  num        TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending',
  r2_key     TEXT,
  error      TEXT,
  scraped_at INTEGER,
  PRIMARY KEY (court, year, num)
);

CREATE INDEX IF NOT EXISTS idx_court_year ON cases (court, year);
CREATE INDEX IF NOT EXISTS idx_status     ON cases (status);
```

**Step 4: Create `wrangler.toml`**

```toml
name = "nzill"
main = "src/index.ts"
compatibility_date = "2025-11-01"
compatibility_flags = ["nodejs_compat"]

[vars]
COURTS = "NZSC,NZCA,NZHC"

[triggers]
crons = ["0 2 * * *"]

[[workflows]]
name = "orchestrator"
binding = "ORCHESTRATOR"
class_name = "OrchestratorWorkflow"
script_name = "nzill"

[[workflows]]
name = "court-scrape"
binding = "COURT_SCRAPE"
class_name = "CourtScrapeWorkflow"
script_name = "nzill"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterDO"

[[migrations]]
tag = "v1"
new_classes = ["RateLimiterDO"]

[[queues.producers]]
binding = "SCRAPE_QUEUE"
queue = "nzill-scrape"

[[queues.consumers]]
queue = "nzill-scrape"
max_batch_size = 10
max_retries = 3
dead_letter_queue = "nzill-scrape-dlq"

[[kv_namespaces]]
binding = "KV"
id = "placeholder"
preview_id = "placeholder"

[[r2_buckets]]
binding = "R2"
bucket_name = "nzill-decisions"
preview_bucket_name = "nzill-decisions-preview"

[[d1_databases]]
binding = "DB"
database_name = "nzill"
database_id = "placeholder"
```

**Step 5: Add mise tasks to `mise.toml`**

Append to existing `mise.toml`:

```toml
[tasks.dev]
run = "wrangler dev"

[tasks.deploy]
run = "wrangler deploy"

[tasks."db:migrate"]
run = "wrangler d1 execute nzill --file=schema.sql"

[tasks."db:migrate:local"]
run = "wrangler d1 execute nzill --local --file=schema.sql"
```

**Step 6: Run typecheck to confirm scaffold compiles**

```bash
mise run typecheck
```

Expected: no errors (src/ is empty so far, only tsconfig is checked).

**Step 7: Commit**

```bash
git add wrangler.toml schema.sql tsconfig.json mise.toml package.json pnpm-lock.yaml
git commit -m "chore: scaffold Cloudflare Worker project"
```

---

## Task 2: Shared Types

**Files:**

- Create: `src/types.ts`

**Step 1: Create `src/types.ts`**

```typescript
// src/types.ts
import type {
  KVNamespace,
  R2Bucket,
  D1Database,
  DurableObjectNamespace,
  Queue,
} from "@cloudflare/workers-types";

// --- Domain types ---

export type Court = { readonly code: string; readonly name: string };
export type CaseLink = {
  readonly num: string;
  readonly title: string;
  readonly url: string;
};
export type CourtsCache = {
  readonly fetchedAt: number;
  readonly courts: readonly Court[];
};

// --- Result<T> ---

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err = { readonly ok: false; readonly error: string };
export type Result<T> = Ok<T> | Err;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = (error: string): Err => ({ ok: false, error });
export const matchResult = <T, U>(
  result: Result<T>,
  onOk: (value: T) => U,
  onErr: (error: string) => U,
): U => (result.ok ? onOk(result.value) : onErr(result.error));

// --- Type utilities ---

export type TypeGuard<T> = (v: unknown) => v is T;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const toErrorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const isCourt: TypeGuard<Court> = (v): v is Court =>
  isRecord(v) && typeof v["code"] === "string" && typeof v["name"] === "string";

export const isCourtsCache: TypeGuard<CourtsCache> = (v): v is CourtsCache =>
  isRecord(v) &&
  typeof v["fetchedAt"] === "number" &&
  Array.isArray(v["courts"]) &&
  (v["courts"] as unknown[]).every(isCourt);

// --- Queue message shape ---

export type QueueMessage = {
  readonly court: string;
  readonly year: number;
  readonly num: string;
  readonly title: string;
  readonly url: string;
};

// --- Env bindings (Worker interface) ---

export interface Env {
  readonly ORCHESTRATOR: Workflow;
  readonly COURT_SCRAPE: Workflow;
  readonly RATE_LIMITER: DurableObjectNamespace;
  readonly SCRAPE_QUEUE: Queue<QueueMessage>;
  readonly KV: KVNamespace;
  readonly R2: R2Bucket;
  readonly DB: D1Database;
  readonly COURTS: string;
}
```

**Step 2: Run typecheck**

```bash
mise run typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared Worker types and Result utilities"
```

---

## Task 3: Parse Library

Move the pure parsing functions from `scrape.ts` into `src/lib/parse.ts` and add tests.

**Files:**

- Create: `src/lib/parse.ts`
- Create: `src/lib/parse.test.ts`

**Step 1: Write failing tests first**

```typescript
// src/lib/parse.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCourts,
  parseCaseLinks,
  cleanTitle,
  detectPdf,
  resolveUrl,
  extractText,
} from "./parse.ts";

describe("parseCourts", () => {
  it("extracts court codes and names from databases page HTML", () => {
    const html = `<a href="/nz/cases/NZSC/">Supreme Court</a>
                  <a href="/nz/cases/NZCA/">Court of Appeal</a>`;
    assert.deepEqual(parseCourts(html), [
      { code: "NZSC", name: "Supreme Court" },
      { code: "NZCA", name: "Court of Appeal" },
    ]);
  });

  it("returns empty array when no courts found", () => {
    assert.deepEqual(parseCourts("<html></html>"), []);
  });
});

describe("parseCaseLinks", () => {
  it("extracts case num, title, and full url", () => {
    const html = `<a href="/nz/cases/NZSC/2026/1.html">Smith v Jones [2026] NZSC 1</a>`;
    const base = "http://www.nzlii.org/nz/cases/NZSC/2026";
    const links = parseCaseLinks(html, base);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.num, "1");
    assert.equal(links[0]?.title, "Smith v Jones");
    assert.equal(links[0]?.url, `${base}/1.html`);
  });
});

describe("cleanTitle", () => {
  it("strips citation suffix", () => {
    assert.equal(
      cleanTitle("Body Corporate v Grimshaw [2026] NZSC 5 (17 February 2026)"),
      "Body Corporate v Grimshaw",
    );
  });

  it("decodes HTML entities", () => {
    assert.equal(cleanTitle("Smith &amp; Jones"), "Smith & Jones");
  });

  it("replaces unsafe filename chars", () => {
    assert.equal(cleanTitle('Re: "Test"'), "Re_ _Test_");
  });
});

describe("detectPdf", () => {
  it("detects object embed", () => {
    assert.equal(detectPdf(`<object data="/files/case.pdf">`), "/files/case.pdf");
  });

  it("detects embed tag", () => {
    assert.equal(detectPdf(`<embed src="/files/case.pdf">`), "/files/case.pdf");
  });

  it("returns null when no PDF", () => {
    assert.equal(detectPdf("<html><body>text</body></html>"), null);
  });
});

describe("resolveUrl", () => {
  it("returns absolute URLs unchanged", () => {
    assert.equal(
      resolveUrl("http://example.com/file.pdf", "http://base.com"),
      "http://example.com/file.pdf",
    );
  });

  it("prepends origin for root-relative paths", () => {
    assert.equal(resolveUrl("/nz/file.pdf", "http://base.com"), "http://www.nzlii.org/nz/file.pdf");
  });

  it("appends relative paths to base", () => {
    assert.equal(resolveUrl("file.pdf", "http://base.com/nz"), "http://base.com/nz/file.pdf");
  });
});

describe("extractText", () => {
  it("strips HTML tags and collapses whitespace", () => {
    const html = `<!--make_database header end--><p>Hello   world</p><!--sino noindex-->`;
    const text = extractText(html);
    assert.ok(text.includes("Hello world"));
    assert.ok(!text.includes("<p>"));
  });

  it("decodes common entities", () => {
    const html = `<!--make_database header end-->Smith &amp; Jones &lt;plaintiff&gt;<!--sino noindex-->`;
    assert.ok(extractText(html).includes("Smith & Jones <plaintiff>"));
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
mise run test
```

Expected: FAIL — `./parse.ts` not found.

**Step 3: Create `src/lib/parse.ts`**

Copy the pure functions verbatim from `scrape.ts` (lines 95–163):

```typescript
// src/lib/parse.ts
import type { Court, CaseLink } from "../types.ts";

/** Extract NZ court codes and names from the databases page HTML. */
export const parseCourts = (html: string): Court[] =>
  [...html.matchAll(/href="\/nz\/cases\/([^/]+)\/"[^>]*>([^<]+)<\/a>/gi)].flatMap(
    ([, code, name]) => (code && name ? [{ code, name: name.trim() }] : []),
  );

/** Extract (caseNum, title, url) tuples from the index page HTML. */
export const parseCaseLinks = (html: string, base: string): CaseLink[] =>
  [...html.matchAll(/<a\s[^>]*href="[^"]*\/(\d+)\.html"[^>]*>([^<]+)<\/a>/gi)].flatMap(
    ([, num, rawTitle]) =>
      num && rawTitle
        ? [{ num, title: cleanTitle(rawTitle.trim()), url: `${base}/${num}.html` }]
        : [],
  );

/**
 * Strip citation suffix and unsafe filename chars from a raw case title.
 * "Body Corporate v Grimshaw [2026] NZSC 5 (17 February 2026)"
 * → "Body Corporate v Grimshaw"
 */
export const cleanTitle = (raw: string): string =>
  raw
    .replace(/\s*\[\d{4}\]\s+\w+\s+\d+.*$/, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();

/** Detect embedded PDF in page HTML. Returns the href/src value or null. */
export const detectPdf = (html: string): string | null =>
  [
    /<object[^>]+data="([^"]+\.pdf)"[^>]*>/i,
    /<embed[^>]+src="([^"]+\.pdf)"[^>]*>/i,
    /<iframe[^>]+src="([^"]+\.pdf)"[^>]*>/i,
  ]
    .map((pat) => pat.exec(html)?.[1])
    .find((m): m is string => m != null) ?? null;

/** Resolve a root-relative or relative URL against the site origin. */
export const resolveUrl = (href: string, base: string): string =>
  href.startsWith("http")
    ? href
    : href.startsWith("/")
      ? `http://www.nzlii.org${href}`
      : `${base}/${href}`;

/**
 * Extract readable plain text from an nzlii HTML decision page.
 * Strips navigation headers/footers, script/style, then collapses tags to whitespace.
 */
export const extractText = (html: string): string => {
  const body =
    /<!--make_database header end-->([\s\S]*?)<!--sino noindex-->/i.exec(html)?.[1] ?? html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
```

**Step 4: Run tests to verify they pass**

```bash
mise run test
```

Expected: all parse tests PASS.

**Step 5: Commit**

```bash
git add src/lib/parse.ts src/lib/parse.test.ts
git commit -m "feat: add parse library (moved from scrape.ts)"
```

---

## Task 4: KV Library

**Files:**

- Create: `src/lib/kv.ts`
- Create: `src/lib/kv.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/kv.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCourts, saveCourts, isYearDone, markYearDone } from "./kv.ts";

// Minimal KVNamespace mock
const makeKV = (store: Record<string, string> = {}) => ({
  store,
  async get(key: string) {
    return store[key] ?? null;
  },
  async put(key: string, value: string) {
    store[key] = value;
  },
  async delete(key: string) {
    delete store[key];
  },
  async list() {
    return { keys: [], list_complete: true, cursor: "" };
  },
  async getWithMetadata(key: string) {
    return { value: store[key] ?? null, metadata: null };
  },
});

describe("getCourts", () => {
  it("returns null when no cache exists", async () => {
    const kv = makeKV();
    assert.equal(await getCourts(kv as never), null);
  });

  it("returns null when cache is expired", async () => {
    const kv = makeKV({
      courts: JSON.stringify({ fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, courts: [] }),
    });
    assert.equal(await getCourts(kv as never), null);
  });

  it("returns courts when cache is fresh", async () => {
    const courts = [{ code: "NZSC", name: "Supreme Court" }];
    const kv = makeKV({
      courts: JSON.stringify({ fetchedAt: Date.now(), courts }),
    });
    assert.deepEqual(await getCourts(kv as never), courts);
  });
});

describe("saveCourts", () => {
  it("writes cache entry with current timestamp", async () => {
    const kv = makeKV();
    const courts = [{ code: "NZSC", name: "Supreme Court" }];
    await saveCourts(kv as never, courts);
    const raw = kv.store["courts"];
    assert.ok(raw);
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.courts, courts);
    assert.ok(typeof parsed.fetchedAt === "number");
  });
});

describe("isYearDone / markYearDone", () => {
  it("returns false when not marked", async () => {
    const kv = makeKV();
    assert.equal(await isYearDone(kv as never, "NZSC", 2020), false);
  });

  it("returns true after marking done", async () => {
    const kv = makeKV();
    await markYearDone(kv as never, "NZSC", 2020);
    assert.equal(await isYearDone(kv as never, "NZSC", 2020), true);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
mise run test
```

Expected: FAIL — `./kv.ts` not found.

**Step 3: Create `src/lib/kv.ts`**

```typescript
// src/lib/kv.ts
import type { KVNamespace } from "@cloudflare/workers-types";
import type { Court, CourtsCache } from "../types.ts";
import { isCourtsCache } from "../types.ts";

const COURTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const getCourts = async (kv: KVNamespace): Promise<readonly Court[] | null> => {
  const raw: unknown = await kv.get("courts", "json");
  if (!isCourtsCache(raw)) return null;
  if (Date.now() - raw.fetchedAt >= COURTS_CACHE_TTL_MS) return null;
  return raw.courts;
};

export const saveCourts = async (kv: KVNamespace, courts: readonly Court[]): Promise<void> => {
  const cache: CourtsCache = { fetchedAt: Date.now(), courts };
  await kv.put("courts", JSON.stringify(cache));
};

export const isYearDone = async (kv: KVNamespace, court: string, year: number): Promise<boolean> =>
  (await kv.get(`done:${court}:${year}`)) === "1";

export const markYearDone = async (kv: KVNamespace, court: string, year: number): Promise<void> => {
  await kv.put(`done:${court}:${year}`, "1");
};
```

**Step 4: Run tests**

```bash
mise run test
```

Expected: all kv tests PASS.

**Step 5: Commit**

```bash
git add src/lib/kv.ts src/lib/kv.test.ts
git commit -m "feat: add KV library (courts cache, year flags)"
```

---

## Task 5: R2 Library

**Files:**

- Create: `src/lib/r2.ts`
- Create: `src/lib/r2.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/r2.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headObject, putText, putBinary, r2Key } from "./r2.ts";

const makeR2 = () => {
  const store = new Map<string, { data: string | ArrayBuffer; contentType: string }>();
  return {
    store,
    async head(key: string) {
      return store.has(key) ? { key } : null;
    },
    async put(
      key: string,
      data: string | ArrayBuffer,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      store.set(key, { data, contentType: opts?.httpMetadata?.contentType ?? "" });
      return null;
    },
    async get(key: string) {
      const entry = store.get(key);
      return entry ? { body: entry.data } : null;
    },
  };
};

describe("headObject", () => {
  it("returns false when object does not exist", async () => {
    const r2 = makeR2();
    assert.equal(await headObject(r2 as never, "NZSC/2026/1 - Smith v Jones.txt"), false);
  });

  it("returns true when object exists", async () => {
    const r2 = makeR2();
    await r2.put("key", "data");
    assert.equal(await headObject(r2 as never, "key"), true);
  });
});

describe("putText", () => {
  it("stores text with correct content type", async () => {
    const r2 = makeR2();
    await putText(r2 as never, "key.txt", "hello");
    assert.equal(r2.store.get("key.txt")?.contentType, "text/plain; charset=utf-8");
    assert.equal(r2.store.get("key.txt")?.data, "hello");
  });
});

describe("putBinary", () => {
  it("stores binary with PDF content type", async () => {
    const r2 = makeR2();
    const buf = new ArrayBuffer(4);
    await putBinary(r2 as never, "key.pdf", buf);
    assert.equal(r2.store.get("key.pdf")?.contentType, "application/pdf");
  });
});

describe("r2Key", () => {
  it("formats key correctly for txt", () => {
    assert.equal(
      r2Key("NZSC", 2026, "1", "Smith v Jones", "txt"),
      "NZSC/2026/1 - Smith v Jones.txt",
    );
  });

  it("formats key correctly for pdf", () => {
    assert.equal(
      r2Key("NZHC", 2020, "42", "Re Application", "pdf"),
      "NZHC/2020/42 - Re Application.pdf",
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
mise run test
```

Expected: FAIL — `./r2.ts` not found.

**Step 3: Create `src/lib/r2.ts`**

```typescript
// src/lib/r2.ts
import type { R2Bucket } from "@cloudflare/workers-types";

export const headObject = async (r2: R2Bucket, key: string): Promise<boolean> =>
  (await r2.head(key)) !== null;

export const putText = async (r2: R2Bucket, key: string, text: string): Promise<void> => {
  await r2.put(key, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
};

export const putBinary = async (r2: R2Bucket, key: string, data: ArrayBuffer): Promise<void> => {
  await r2.put(key, data, {
    httpMetadata: { contentType: "application/pdf" },
  });
};

export const r2Key = (
  court: string,
  year: number,
  num: string,
  title: string,
  ext: "txt" | "pdf",
): string => `${court}/${year}/${num} - ${title}.${ext}`;
```

**Step 4: Run tests**

```bash
mise run test
```

Expected: all r2 tests PASS.

**Step 5: Commit**

```bash
git add src/lib/r2.ts src/lib/r2.test.ts
git commit -m "feat: add R2 library (head, putText, putBinary, r2Key)"
```

---

## Task 6: D1 Library

**Files:**

- Create: `src/lib/d1.ts`
- Create: `src/lib/d1.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/d1.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { upsertCase, markDone, markError, queryCases } from "./d1.ts";

type Row = Record<string, unknown>;

// Minimal D1 mock: executes statements against an in-memory array of rows
const makeD1 = (rows: Row[] = []) => {
  const makeStmt = (sql: string, bindings: unknown[]) => ({
    async run() {
      if (sql.startsWith("INSERT INTO cases")) {
        const [court, year, num, title, url] = bindings as [string, number, string, string, string];
        const exists = rows.some(
          (r) => r["court"] === court && r["year"] === year && r["num"] === num,
        );
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
      } else if (sql.startsWith("UPDATE cases SET status")) {
        const isError = sql.includes("error");
        if (isError) {
          const [status, error, scraped_at, court, year, num] = bindings as [
            string,
            string,
            number,
            string,
            number,
            string,
          ];
          const row = rows.find(
            (r) => r["court"] === court && r["year"] === year && r["num"] === num,
          );
          if (row) Object.assign(row, { status, error, scraped_at });
        } else {
          const [status, r2_key, scraped_at, court, year, num] = bindings as [
            string,
            string,
            number,
            string,
            number,
            string,
          ];
          const row = rows.find(
            (r) => r["court"] === court && r["year"] === year && r["num"] === num,
          );
          if (row) Object.assign(row, { status, r2_key, scraped_at });
        }
      }
    },
    async all() {
      if (sql.startsWith("SELECT")) {
        const [court, year] = bindings as [string, number];
        return { results: rows.filter((r) => r["court"] === court && r["year"] === year) };
      }
      return { results: [] };
    },
  });
  return {
    rows,
    prepare: (sql: string) => ({
      bind: (...bindings: unknown[]) => makeStmt(sql, bindings),
    }),
  };
};

describe("upsertCase", () => {
  it("inserts a new case with pending status", async () => {
    const db = makeD1();
    await upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "http://example.com/1.html");
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0]?.["status"], "pending");
  });

  it("does not duplicate on second insert", async () => {
    const db = makeD1();
    await upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "http://example.com/1.html");
    await upsertCase(db as never, "NZSC", 2026, "1", "Smith v Jones", "http://example.com/1.html");
    assert.equal(db.rows.length, 1);
  });
});

describe("markDone", () => {
  it("sets status to done and records r2_key", async () => {
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
    await markDone(db as never, "NZSC", 2026, "1", "NZSC/2026/1 - Smith v Jones.txt");
    assert.equal(db.rows[0]?.["status"], "done");
    assert.equal(db.rows[0]?.["r2_key"], "NZSC/2026/1 - Smith v Jones.txt");
  });
});

describe("markError", () => {
  it("sets status to error and records message", async () => {
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
    await markError(db as never, "NZSC", 2026, "1", "HTTP 404");
    assert.equal(db.rows[0]?.["status"], "error");
    assert.equal(db.rows[0]?.["error"], "HTTP 404");
  });
});

describe("queryCases", () => {
  it("returns cases filtered by court and year", async () => {
    const db = makeD1([
      { court: "NZSC", year: 2026, num: "1", status: "done" },
      { court: "NZCA", year: 2026, num: "2", status: "done" },
    ]);
    const results = await queryCases(db as never, "NZSC", 2026);
    assert.equal(results.length, 1);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
mise run test
```

Expected: FAIL — `./d1.ts` not found.

**Step 3: Create `src/lib/d1.ts`**

```typescript
// src/lib/d1.ts
import type { D1Database } from "@cloudflare/workers-types";

export const upsertCase = async (
  db: D1Database,
  court: string,
  year: number,
  num: string,
  title: string,
  url: string,
): Promise<void> => {
  await db
    .prepare(
      "INSERT INTO cases (court, year, num, title, url) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(court, year, num, title, url)
    .run();
};

export const markDone = async (
  db: D1Database,
  court: string,
  year: number,
  num: string,
  r2_key: string,
): Promise<void> => {
  await db
    .prepare(
      "UPDATE cases SET status = ?, r2_key = ?, scraped_at = ? WHERE court = ? AND year = ? AND num = ?",
    )
    .bind("done", r2_key, Date.now(), court, year, num)
    .run();
};

export const markError = async (
  db: D1Database,
  court: string,
  year: number,
  num: string,
  error: string,
): Promise<void> => {
  await db
    .prepare(
      "UPDATE cases SET status = ?, error = ?, scraped_at = ? WHERE court = ? AND year = ? AND num = ?",
    )
    .bind("error", error, Date.now(), court, year, num)
    .run();
};

export const queryCases = async (
  db: D1Database,
  court: string,
  year: number,
): Promise<unknown[]> => {
  const result = await db
    .prepare("SELECT * FROM cases WHERE court = ? AND year = ? ORDER BY CAST(num AS INTEGER) DESC")
    .bind(court, year)
    .all();
  return result.results;
};
```

**Step 4: Run tests**

```bash
mise run test
```

Expected: all d1 tests PASS.

**Step 5: Commit**

```bash
git add src/lib/d1.ts src/lib/d1.test.ts
git commit -m "feat: add D1 library (upsertCase, markDone, markError, queryCases)"
```

---

## Task 7: RateLimiterDO

No unit tests for the DO (it requires the Workers runtime). Type-check only.

**Files:**

- Create: `src/objects/rate-limiter.ts`

**Step 1: Create `src/objects/rate-limiter.ts`**

```typescript
// src/objects/rate-limiter.ts
import { DurableObject } from "cloudflare:workers";

const MIN_FETCH_GAP_MS = 800;
const FETCH_JITTER_MS = 2000;

/**
 * Single global instance — enforces a polite request gap to nzlii.org
 * across all concurrent Queue Consumer Worker instances.
 *
 * Slots are reserved synchronously before any await, so no two concurrent
 * callers claim the same slot (DO is single-threaded).
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
```

**Step 2: Run typecheck**

```bash
mise run typecheck
```

Expected: no errors. (`cloudflare:workers` types are provided by `@cloudflare/workers-types`.)

**Step 3: Commit**

```bash
git add src/objects/rate-limiter.ts
git commit -m "feat: add RateLimiterDO (global token bucket for nzlii.org)"
```

---

## Task 8: CourtScrapeWorkflow

**Files:**

- Create: `src/workflows/court-scrape.ts`

**Step 1: Create `src/workflows/court-scrape.ts`**

```typescript
// src/workflows/court-scrape.ts
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../types.ts";
import { parseCaseLinks } from "../lib/parse.ts";
import { upsertCase } from "../lib/d1.ts";
import { markYearDone } from "../lib/kv.ts";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
} as const;

type Params = { readonly court: string; readonly year: number };

export class CourtScrapeWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    const { court, year } = event.payload;
    const base = `http://www.nzlii.org/nz/cases/${court}/${year}`;

    const cases = await step.do("fetch-index", async () => {
      const res = await fetch(`${base}/`, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching index for ${court}/${year}`);
      const html = await res.text();
      return parseCaseLinks(html, base);
    });

    if (cases.length === 0) return;

    await step.do("upsert-cases", async () => {
      for (const c of cases) {
        await upsertCase(this.env.DB, court, year, c.num, c.title, c.url);
      }
    });

    await step.do("enqueue", async () => {
      const messages = cases.map((c) => ({
        body: { court, year, num: c.num, title: c.title, url: c.url },
      }));
      // sendBatch sends up to 100 messages; chunk if needed
      for (let i = 0; i < messages.length; i += 100) {
        await this.env.SCRAPE_QUEUE.sendBatch(messages.slice(i, i + 100));
      }
    });

    await step.do("mark-done", async () => {
      const currentYear = new Date().getFullYear();
      if (year < currentYear) {
        await markYearDone(this.env.KV, court, year);
      }
    });
  }
}
```

**Step 2: Run typecheck**

```bash
mise run typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/workflows/court-scrape.ts
git commit -m "feat: add CourtScrapeWorkflow (index fetch, D1 upsert, Queue enqueue)"
```

---

## Task 9: OrchestratorWorkflow

**Files:**

- Create: `src/workflows/orchestrator.ts`

**Step 1: Create `src/workflows/orchestrator.ts`**

```typescript
// src/workflows/orchestrator.ts
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../types.ts";
import { getCourts, saveCourts, isYearDone } from "../lib/kv.ts";
import { parseCourts } from "../lib/parse.ts";

const DATABASES_URL = "http://www.nzlii.org/databases.html";
const SCRAPE_FROM_YEAR = 2000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
} as const;

export class OrchestratorWorkflow extends WorkflowEntrypoint<Env> {
  async run(_event: WorkflowEvent<never>, step: WorkflowStep): Promise<void> {
    const courts = await step.do("resolve-courts", async () => {
      const cached = await getCourts(this.env.KV);
      if (cached)
        return this.env.COURTS.split(",")
          .map((c) => c.trim())
          .filter(Boolean);

      const res = await fetch(DATABASES_URL, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching courts list`);
      const all = parseCourts(await res.text());
      await saveCourts(this.env.KV, all);

      return this.env.COURTS.split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    });

    const currentYear = new Date().getFullYear();

    // One step per court: iterate all years inside it to minimise total step count
    for (const court of courts) {
      await step.do(`spawn-${court}`, async () => {
        for (let year = currentYear; year >= SCRAPE_FROM_YEAR; year--) {
          const skip = year < currentYear && (await isYearDone(this.env.KV, court, year));
          if (!skip) {
            const id = `${court}-${year}-${new Date().toISOString().slice(0, 10)}`;
            await this.env.COURT_SCRAPE.create({ id, params: { court, year } });
          }
        }
      });
    }
  }
}
```

**Step 2: Run typecheck**

```bash
mise run typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/workflows/orchestrator.ts
git commit -m "feat: add OrchestratorWorkflow (fan-out per court×year, recent-first)"
```

---

## Task 10: Worker Entry + Queue Consumer + HTTP API

**Files:**

- Create: `src/index.ts`

**Step 1: Create `src/index.ts`**

```typescript
// src/index.ts
import type {
  MessageBatch,
  ScheduledEvent,
  ExecutionContext,
  ExportedHandler,
} from "@cloudflare/workers-types";
import type { Env, QueueMessage } from "./types.ts";
import { toErrorMessage, matchResult, ok, err } from "./types.ts";
import { detectPdf, resolveUrl, extractText } from "./lib/parse.ts";
import { getCourts } from "./lib/kv.ts";
import { headObject, putText, putBinary, r2Key } from "./lib/r2.ts";
import { markDone, markError, queryCases } from "./lib/d1.ts";
import { OrchestratorWorkflow } from "./workflows/orchestrator.ts";
import { CourtScrapeWorkflow } from "./workflows/court-scrape.ts";
import { RateLimiterDO } from "./objects/rate-limiter.ts";

export { OrchestratorWorkflow, CourtScrapeWorkflow, RateLimiterDO };

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
} as const;

const processCase = async (
  env: Env,
  msg: QueueMessage,
): Promise<ReturnType<typeof ok<string> | typeof err>> => {
  const { court, year, num, title, url } = msg;
  const base = `http://www.nzlii.org/nz/cases/${court}/${year}`;

  try {
    // Deduplicate via R2 HEAD
    const txtKey = r2Key(court, year, num, title, "txt");
    const pdfKey = r2Key(court, year, num, title, "pdf");
    if ((await headObject(env.R2, txtKey)) || (await headObject(env.R2, pdfKey))) {
      return ok(`SKIP ${court}/${year}/${num}`);
    }

    const pageRes = await fetch(url, { headers: HEADERS });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status} for ${url}`);
    const pageHtml = await pageRes.text();

    const pdfHref = detectPdf(pageHtml);
    if (pdfHref) {
      const pdfRes = await fetch(resolveUrl(pdfHref, base), { headers: HEADERS });
      if (!pdfRes.ok) throw new Error(`HTTP ${pdfRes.status} for PDF`);
      await putBinary(env.R2, pdfKey, await pdfRes.arrayBuffer());
      await markDone(env.DB, court, year, num, pdfKey);
      return ok(`PDF ${pdfKey}`);
    }

    const text = extractText(pageHtml);
    await putText(env.R2, txtKey, text);
    await markDone(env.DB, court, year, num, txtKey);
    return ok(`TXT ${txtKey}`);
  } catch (e) {
    const msg_ = toErrorMessage(e);
    await markError(env.DB, court, year, num, msg_);
    return err(msg_);
  }
};

const handleFetch = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/courts") {
    const courts = await getCourts(env.KV);
    return Response.json(courts ?? []);
  }

  if (url.pathname === "/decisions") {
    const court = url.searchParams.get("court");
    const yearStr = url.searchParams.get("year");
    if (!court || !yearStr) {
      return new Response("Missing court or year query param", { status: 400 });
    }
    const year = parseInt(yearStr, 10);
    if (isNaN(year)) return new Response("Invalid year", { status: 400 });
    const cases = await queryCases(env.DB, court, year);
    return Response.json(cases);
  }

  const fileMatch = /^\/decisions\/([^/]+)\/(\d+)\/(\d+)$/.exec(url.pathname);
  if (fileMatch) {
    const [, court, yearStr, num] = fileMatch;
    if (!court || !yearStr || !num) return new Response("Not found", { status: 404 });
    // Try txt then pdf
    for (const ext of ["txt", "pdf"] as const) {
      // Look up r2_key from D1 (no need to guess the title)
      const rows = await queryCases(env.DB, court, parseInt(yearStr, 10));
      const row = (rows as Array<{ num: string; r2_key: string | null }>).find(
        (r) => r.num === num && r.r2_key !== null,
      );
      if (row?.r2_key) {
        const obj = await env.R2.get(row.r2_key);
        if (obj) {
          const ct = ext === "pdf" ? "application/pdf" : "text/plain; charset=utf-8";
          return new Response(obj.body as BodyInit, {
            headers: { "Content-Type": ct },
          });
        }
      }
    }
    return new Response("Not found", { status: 404 });
  }

  if (url.pathname === "/scrape" && request.method === "POST") {
    await env.ORCHESTRATOR.create({});
    return new Response("Scrape triggered", { status: 202 });
  }

  return new Response("Not found", { status: 404 });
};

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(env.ORCHESTRATOR.create({}));
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("global"));
    for (const msg of batch.messages) {
      await (stub as unknown as { waitForSlot(): Promise<void> }).waitForSlot();
      matchResult(
        await processCase(env, msg.body),
        (s) => console.log(s),
        (e) => console.error(`ERROR ${msg.body.court}/${msg.body.year}/${msg.body.num}: ${e}`),
      );
      msg.ack();
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
} satisfies ExportedHandler<Env>;
```

**Step 2: Run typecheck**

```bash
mise run typecheck
```

Expected: no errors.

**Step 3: Run all tests**

```bash
mise run test
```

Expected: all tests still PASS (index.ts has no unit tests — integration is covered by the library tests).

**Step 4: Run lint**

```bash
mise run lint
```

Expected: 0 warnings, 0 errors.

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add Worker entry with Queue consumer and HTTP API"
```

---

## Task 11: Provision Cloudflare Resources + Smoke Test

**Step 1: Create KV namespace**

```bash
wrangler kv namespace create NZILL_KV
wrangler kv namespace create NZILL_KV --preview
```

Copy the returned `id` and `preview_id` into `wrangler.toml` under `[[kv_namespaces]]`.

**Step 2: Create R2 bucket**

```bash
wrangler r2 bucket create nzill-decisions
wrangler r2 bucket create nzill-decisions-preview
```

**Step 3: Create D1 database**

```bash
wrangler d1 create nzill
```

Copy the returned `database_id` into `wrangler.toml` under `[[d1_databases]]`.

**Step 4: Create Queue**

```bash
wrangler queues create nzill-scrape
wrangler queues create nzill-scrape-dlq
```

**Step 5: Run local D1 migration**

```bash
mise run db:migrate:local
```

Expected: schema created with no errors.

**Step 6: Smoke test with wrangler dev**

```bash
mise run dev
```

In another terminal:

```bash
# Trigger manual scrape
curl -X POST http://localhost:8787/scrape

# List courts (empty until first run)
curl http://localhost:8787/courts

# Query decisions
curl "http://localhost:8787/decisions?court=NZSC&year=2026"
```

Expected: 202 for POST, `[]` for GET until scrape runs.

**Step 7: Update wrangler.toml with real IDs and commit**

```bash
git add wrangler.toml
git commit -m "chore: add provisioned Cloudflare resource IDs to wrangler.toml"
```

**Step 8: Deploy**

```bash
mise run deploy
```

Expected: `nzill` deployed successfully. Check Cloudflare dashboard to confirm Cron Trigger is registered.
