# nzill

A Cloudflare Workers scraper that fetches New Zealand court decisions from [nzlii.org](http://www.nzlii.org) and stores them as plain text or PDF in R2 object storage.

## Overview

nzill runs entirely on Cloudflare's edge infrastructure. A nightly cron triggers the orchestrator, which fans out one Workflow per court per year, enqueues individual case scrape jobs, and a rate-limited queue consumer fetches and stores each decision.

## Cloud Architecture

```mermaid
graph TD
    CRON["Cron Trigger\n(daily 02:00 UTC)"]
    HTTP["HTTP API\n(Workers fetch handler)"]

    subgraph Workflows
        OW["OrchestratorWorkflow\n· resolves courts from env\n· spawns CourtScrapeWorkflow\n  per court × year"]
        CSW["CourtScrapeWorkflow\n· fetches nzlii.org index page\n· upserts case rows to D1\n· enqueues scrape jobs\n· marks year done in KV"]
    end

    subgraph "Queue Consumer (Worker)"
        QC["Queue Consumer\n· checks rate limiter\n· fetches case page\n· detects PDF vs HTML\n· stores to R2\n· marks done/error in D1"]
        RL["RateLimiterDO\n(Durable Object)\n· enforces ≥800 ms gap\n· adds random jitter\n· 503 if backlog > 8 s"]
    end

    subgraph Storage
        D1[("D1 SQLite\ncases table\n(court, year, num, status, r2_key)")]
        R2[("R2 Bucket\nnzill-decisions\nCOURT/YEAR/N - Title.txt\nCOURT/YEAR/N - Title.pdf")]
        KV[("KV Namespace\ncourts cache · done:COURT:YEAR flags")]
    end

    NZLII["nzlii.org\n(external)"]

    CRON -->|"env.ORCHESTRATOR.create()"| OW
    HTTP -->|"POST /scrape"| OW
    HTTP -->|"GET /courts"| KV
    HTTP -->|"GET /decisions"| D1
    HTTP -->|"GET /decisions/:court/:year/:num"| R2

    OW -->|"env.COURT_SCRAPE.create()"| CSW
    CSW -->|"fetch index"| NZLII
    CSW -->|"upsertCase()"| D1
    CSW -->|"sendBatch()"| QC
    CSW -->|"markYearDone()"| KV

    QC -->|"fetch /slot"| RL
    QC -->|"fetch case / PDF"| NZLII
    QC -->|"putText / putBinary"| R2
    QC -->|"markDone / markError"| D1
```

### Data flow

```mermaid
sequenceDiagram
    participant Cron
    participant Orchestrator as OrchestratorWorkflow
    participant Scraper as CourtScrapeWorkflow
    participant Queue as Queue Consumer
    participant RL as RateLimiterDO
    participant NZLII as nzlii.org
    participant D1
    participant R2
    participant KV

    Cron->>Orchestrator: create()
    loop each court
        Orchestrator->>KV: getDoneYears(court)
        loop each year (2000–present, skip done)
            Orchestrator->>Scraper: create(court, year)
        end
    end

    Scraper->>NZLII: GET /nz/cases/{court}/{year}/
    NZLII-->>Scraper: HTML index
    Scraper->>D1: upsertCase() × N
    Scraper->>Queue: sendBatch() × N
    Scraper->>KV: markYearDone() (historical only)

    loop each queued message
        Queue->>RL: GET /slot
        alt backlog OK
            RL-->>Queue: 200 OK (after wait)
            Queue->>NZLII: GET case page
            alt PDF embedded
                Queue->>NZLII: GET PDF binary
                Queue->>R2: putBinary(COURT/YEAR/N - Title.pdf)
            else HTML decision
                Queue->>R2: putText(COURT/YEAR/N - Title.txt)
            end
            Queue->>D1: markDone(r2_key)
        else backlog too deep
            RL-->>Queue: 503
            Queue->>Queue: retryAll(delay=60s)
        end
    end
```

### Storage layout

| Store  | Key pattern                | Contents                                                            |
| ------ | -------------------------- | ------------------------------------------------------------------- |
| **R2** | `COURT/YEAR/N - Title.txt` | Extracted decision text (HTML decisions)                            |
| **R2** | `COURT/YEAR/N - Title.pdf` | Raw PDF binary (PDF-embedded decisions)                             |
| **D1** | `cases` table              | `(court, year, num, title, url, status, r2_key, error, scraped_at)` |
| **KV** | `courts`                   | Cached JSON list of all 135 NZ courts (7-day TTL)                   |
| **KV** | `done:COURT:YEAR`          | Sentinel — historical year fully scraped, skip on next run          |

## HTTP API

| Method | Path                              | Description                                              |
| ------ | --------------------------------- | -------------------------------------------------------- |
| `GET`  | `/courts`                         | List all NZ courts (KV-cached, refreshed from nzlii.org) |
| `GET`  | `/decisions?court=NZSC&year=2024` | List decisions for a court-year from D1                  |
| `GET`  | `/decisions/:court/:year/:num`    | Stream the stored decision (text or PDF) from R2         |
| `POST` | `/scrape`                         | Manually trigger the orchestrator                        |

## Project structure

```
src/
  index.ts                   # Worker entry point — HTTP handler, queue consumer, scheduled trigger
  types.ts                   # Shared types, schemas (Effect Schema), error constructors
  workflows/
    orchestrator.ts           # OrchestratorWorkflow — fans out court × year jobs
    court-scrape.ts           # CourtScrapeWorkflow — indexes one court/year, enqueues cases
  objects/
    rate-limiter.ts           # RateLimiterDO — global polite-crawl rate limiter
  lib/
    d1.ts                     # D1 queries (upsertCase, markDone, markError, queryCases)
    kv.ts                     # KV helpers (courts cache, year-done flags)
    parse.ts                  # HTML parsing (courts list, case links, text extraction, PDF detection)
    r2.ts                     # R2 helpers (headObject, putText, putBinary, makeR2Key)
scrape.ts                    # Local CLI scraper (no Cloudflare — writes to output/)
schema.sql                   # D1 schema migration
wrangler.toml                # Cloudflare resource bindings
```

## Development

### Prerequisites

- [mise](https://mise.jdx.dev) — manages Node.js, pnpm, pkl, hk
- A Cloudflare account with Workers Paid (Workflows + Queues require it)

### Setup

```sh
mise install          # install Node, pnpm, pkl, hk
mise run install      # pnpm install --frozen-lockfile
```

### Local CLI scraper

A standalone `scrape.ts` runs against nzlii.org directly and writes files to `output/` — no Cloudflare account needed.

```sh
mise run scrape                   # list all 135 NZ courts
mise run scrape NZSC              # list Supreme Court years
mise run scrape NZSC 2024         # scrape all 2024 Supreme Court decisions
```

### Wrangler dev

```sh
mise run dev          # wrangler dev (local Workers simulator)
```

> **Note:** `fetch()` inside `step.do()` is not supported in the local wrangler simulator. The orchestrator and court-scrape workflows work correctly in production only.

### Trigger a manual scrape

```sh
# Via HTTP (wrangler dev running)
curl -X POST http://localhost:8787/scrape

# Via Cloudflare Dashboard → Workers → nzill → Triggers → Cron → Run
# Or: Dashboard → Workflows → orchestrator → Create instance
```

## Testing

```sh
mise run test             # node:test unit tests (parse, kv, r2, d1)
mise run test:workers     # Vitest Workers pool — RateLimiterDO + HTTP handler integration tests
mise run typecheck        # oxlint --type-check --type-aware
mise run lint             # oxlint --type-aware --fix
mise run fmt              # oxfmt (auto-fix)
mise run fmt:check        # oxfmt --check (CI)
```

## CI / CD

GitHub Actions workflows are generated from PKL sources in `.github/pkl/`. **Edit the `.pkl` files, not the generated YAML.**

```sh
mise run pkl:gen          # regenerate .github/workflows/*.yml
```

| Workflow   | Trigger                                 | Steps                                                  |
| ---------- | --------------------------------------- | ------------------------------------------------------ |
| **CI**     | every push                              | pkl:gen check · typecheck · lint · fmt:check · test    |
| **Deploy** | push to `master` (src/wrangler changes) | typecheck · lint · test · db:migrate · wrangler deploy |

### Secrets required

| Secret                  | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Wrangler deploy token (Edit Workers permission) |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID                      |

## Configuration

Set courts to scrape in `wrangler.toml`:

```toml
[vars]
COURTS = "NZSC,NZCA,NZHC,NZDC"   # comma-separated court codes
```

Find court codes with `mise run scrape` (lists all 135 courts and their codes).

## Deployment

```sh
mise run db:migrate       # apply schema.sql to production D1
mise run deploy           # wrangler deploy
```

## Rate limiting

The `RateLimiterDO` Durable Object enforces a global crawl rate across all concurrent queue consumer Workers:

- **Minimum gap:** 800 ms between requests
- **Jitter:** 0–2000 ms added randomly to avoid thundering-herd
- **Max lookahead:** 8 s — if the queue is backed up beyond this, the DO returns 503 and the consumer retries the entire batch after 60 s

This keeps nzlii.org request rates polite regardless of queue depth or Worker concurrency.
