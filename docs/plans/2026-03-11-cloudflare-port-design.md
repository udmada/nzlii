# Cloudflare Port Design

**Date:** 2026-03-11
**Goal:** Port the NZ legal decision scraper from a local CLI to a fully automated, always-on Cloudflare-hosted service using Workers, Workflows, Queues, Durable Objects, KV, R2, and D1.

---

## Motivation

Replace the current `mise run scrape` local CLI with a scheduled Cloudflare service that:

- Runs daily without a local machine
- Backfills all available decisions from year 2000 to present
- Prioritises recent years first
- Stores decisions in R2 (queryable via HTTP API)
- Tracks metadata and scrape state in D1

---

## Architecture

```
Cron (daily 2am UTC)
  └─► OrchestratorWorkflow
        reads COURTS env var (comma-separated)
        iterates years: currentYear → 2000
        skips year if KV `done:{court}:{year}` = "1"
        └─► CourtScrapeWorkflow { court, year }  (one per court × year)
              step("fetch-index")  → fetch + parse case links
                                   → upsert rows into D1 (status=pending)
              step("enqueue")      → push one Queue message per case
              step("mark-done")    → if year < currentYear:
                                       KV.set(`done:{court}:{year}`, "1")

Queue Consumer Worker (per message: { court, year, num, title, url })
  └─► RateLimiterDO.waitForSlot()   ← global token bucket
  └─► fetch page → detectPdf → R2.put → D1.markDone | D1.markError
```

**Key design decisions:**

- Workflows handle orchestration only (index fetch + enqueue). Keeping them lean avoids hitting the Workflow step limit on large courts (NZHC can have 1000+ cases/year).
- Queues handle per-case fan-out with automatic retries and backpressure.
- `RateLimiterDO` enforces a true global request gap to nzlii.org across all concurrent Queue Consumer instances — the same `nextFetchMs` token-bucket pattern as `scrape.ts` but persisted in a DO.
- The Orchestrator spawns workflows from `currentYear` down to 2000. Past years are skipped once marked done in KV, so subsequent daily runs only spawn workflows for the current year.

---

## Storage

### KV (`NZILL_KV`)

| Key                   | Value                                    | Purpose                         |
| --------------------- | ---------------------------------------- | ------------------------------- |
| `courts`              | `{ fetchedAt: number, courts: Court[] }` | 7-day courts cache              |
| `done:{COURT}:{YEAR}` | `"1"`                                    | Historical year completion flag |

### R2 (`nzill-decisions`)

Object key format: `{COURT}/{YEAR}/{N} - {Title}.txt` or `{COURT}/{YEAR}/{N} - {Title}.pdf`

R2 HEAD requests (Class B ops) are used for deduplication inside the Queue Consumer — if the object exists, skip fetching.

### D1 (`nzill`)

```sql
CREATE TABLE cases (
  court      TEXT    NOT NULL,
  year       INTEGER NOT NULL,
  num        TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending', -- pending | done | error
  r2_key     TEXT,
  error      TEXT,
  scraped_at INTEGER,
  PRIMARY KEY (court, year, num)
);

CREATE INDEX idx_court_year ON cases (court, year);
CREATE INDEX idx_status     ON cases (status);
```

D1 serves two purposes:

1. Queryable metadata index (powers the HTTP API)
2. Error tracking — failed cases stay as `status='error'` and are visible for inspection

---

## Components

### `OrchestratorWorkflow`

- Entry point for the daily Cron
- Reads `COURTS` env var, computes year range `currentYear → 2000`
- For each `{court, year}` pair: checks `done:{court}:{year}` in KV; if absent, spawns a `CourtScrapeWorkflow`
- Fire-and-forget (does not await child workflows)

### `CourtScrapeWorkflow`

- Receives `{ court: string, year: number }`
- `step("fetch-index")`: fetches `https://www.nzlii.org/nz/cases/{court}/{year}/`, parses case links, upserts all rows into D1 as `pending`
- `step("enqueue")`: pushes one Queue message per case
- `step("mark-done")`: if `year < currentYear`, writes `done:{court}:{year}` to KV
- Workflow ID: `{court}-{year}-{isoDate}` for deduplication and resumability

### Queue Consumer Worker

- Receives `{ court, year, num, title, url }`
- Checks R2 for existing object (HEAD) — skips if present
- Calls `RateLimiterDO.waitForSlot()` before fetching
- Fetches the case page, calls `detectPdf` — downloads PDF binary or extracts plain text
- Writes to R2 under `{COURT}/{YEAR}/{N} - {Title}.txt|pdf`
- Updates D1: `markDone(court, year, num, r2Key)` or `markError(court, year, num, errorMsg)`
- Queue retries (up to 3) handle transient HTTP failures

### `RateLimiterDO`

- Single global instance (named `"global"`)
- Maintains `nextFetchMs` in-memory (DO single-threaded, no races)
- `waitForSlot()`: same token-bucket logic as `scrape.ts` — enforces `MIN_FETCH_GAP_MS` (800ms) + random jitter (up to 2000ms) across all concurrent Consumer instances

### HTTP API (Worker `fetch` handler)

| Route                                 | Description                                         |
| ------------------------------------- | --------------------------------------------------- |
| `GET /courts`                         | List courts from KV cache                           |
| `GET /decisions?court=NZSC&year=2023` | Query D1 by court + year                            |
| `GET /decisions/:court/:year/:num`    | Stream file from R2                                 |
| `POST /scrape`                        | Manually trigger OrchestratorWorkflow (dev/testing) |

---

## Project Structure

```
src/
  index.ts                    # Worker entry: scheduled + fetch handlers
  workflows/
    orchestrator.ts           # OrchestratorWorkflow
    court-scrape.ts           # CourtScrapeWorkflow
  objects/
    rate-limiter.ts           # RateLimiterDO
  lib/
    parse.ts                  # Pure fns from scrape.ts (unchanged)
    kv.ts                     # getCourts, saveCourts, isYearDone, markYearDone
    r2.ts                     # headObject, putText, putBinary
    d1.ts                     # upsertCase, markDone, markError, queryCases
  types.ts                    # Court, CaseLink, Result<T>, Env interface
  lib/parse.test.ts           # Unit tests for parse.ts
  lib/kv.test.ts              # Unit tests for kv.ts
  lib/r2.test.ts              # Unit tests for r2.ts
  lib/d1.test.ts              # Unit tests for d1.ts
schema.sql                    # D1 schema + indexes
wrangler.toml                 # Cloudflare config
tsconfig.json
mise.toml
package.json
```

---

## Toolchain

Mirrors the current project conventions:

| Tool       | Version  | Notes                                                    |
| ---------- | -------- | -------------------------------------------------------- |
| Node LTS   | via mise | runtime + `node:test` unit tests                         |
| TypeScript | 7.0      | wrangler bundles; `--experimental-strip-types` for tests |
| wrangler   | latest   | dev + deploy                                             |
| pnpm       | latest   | package manager                                          |
| oxlint     | latest   | `--tsconfig=tsconfig.json --type-aware`                  |
| oxfmt      | latest   | formatting                                               |

devDependencies only — no runtime npm deps.

### mise tasks

```toml
[tasks.dev]          run = "wrangler dev"
[tasks.deploy]       run = "wrangler deploy"
[tasks.typecheck]    run = "tsc --noEmit"
[tasks.lint]         run = "oxlint --tsconfig=tsconfig.json --type-aware src"
[tasks.fmt]          run = "oxfmt src"
[tasks."fmt:check"]  run = "oxfmt --check src"
[tasks.test]         run = "node --experimental-strip-types --test 'src/**/*.test.ts'"
[tasks."db:migrate"] run = "wrangler d1 execute nzill --file=schema.sql"
```

---

## Code Conventions

Same as `scrape.ts`:

- Functional style: pure functions, `const` arrow functions, `matchAll`+`flatMap`
- `Result<T>` = `Ok<T> | Err` with `ok()`, `err()`, `matchResult()`
- No `as X` casts; `TypeGuard<T>` + `isRecord` for runtime narrowing
- `toErrorMessage(unknown)` instead of `(e as Error).message`
- `node:` prefix for builtins

The pure parsing functions (`parseCourts`, `parseCaseLinks`, `cleanTitle`, `detectPdf`, `resolveUrl`, `extractText`) move from `scrape.ts` into `src/lib/parse.ts` unchanged.

---

## Configuration

```toml
# wrangler.toml (excerpt)
[vars]
COURTS = "NZSC,NZCA,NZHC"   # override per environment

[triggers]
crons = ["0 2 * * *"]

[[workflows]]
name = "orchestrator"
binding = "ORCHESTRATOR"
class_name = "OrchestratorWorkflow"

[[workflows]]
name = "court-scrape"
binding = "COURT_SCRAPE"
class_name = "CourtScrapeWorkflow"

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
max_batch_size = 1
max_retries = 3

[[kv_namespaces]]
binding = "KV"
id = "..."

[[r2_buckets]]
binding = "R2"
bucket_name = "nzill-decisions"

[[d1_databases]]
binding = "DB"
database_name = "nzill"
database_id = "..."
```
