- Use `zsh` to write shell-compatible scripts, wherever you try to use `bash`
- Most CLIs are managed by `mise` — use `mise exec -- <cmd>` or ensure mise shims are on PATH

## Project

NZ legal decision scraper. Fetches court decisions from nzlii.org and saves them as `.txt` (HTML decisions) or `.pdf` (PDF-embedded decisions), named `<N> - <Title>.[txt|pdf]`.

## Tech stack

- **Runtime:** Node (lts) via mise, TypeScript via `--experimental-strip-types` (no compilation step)
- **Package manager:** pnpm
- **Linting:** oxlint with `--tsconfig=tsconfig.json --type-aware` + oxlint-tsgolint
- **Formatting:** oxfmt
- **Git hooks:** hk (config in `hk.pkl`, PKL format)
- **CI:** GitHub Actions generated from PKL sources in `.github/pkl/` — run `mise run pkl:gen` to regenerate YAML

## Mise tasks

```
mise run scrape [COURT] [YEAR]   # scrape decisions; no args lists all 135 NZ courts
mise run scrape                  # list available courts (cached 7 days in .cache/courts.json)
mise run test                    # node:test unit tests (no build needed)
mise run typecheck               # tsc --noEmit
mise run lint                    # oxlint type-aware
mise run fmt                     # oxfmt (auto-fix)
mise run fmt:check               # oxfmt check (CI)
mise run pkl:gen                 # regenerate .github/workflows/*.yml from pkl sources
mise run install                 # pnpm install --frozen-lockfile
```

## Code conventions

- **Functional style:** pure functions, `const` arrow functions, `matchAll`+`flatMap` over imperative loops, immutable types (`readonly`)
- **Result type:** use `Result<T> = Ok<T> | Err` with `ok()`, `err()`, `matchResult()` — no throwing across boundaries
- **Type safety:** no `as X` casts; use `TypeGuard<T>` + `isRecord` for runtime narrowing (e.g. JSON.parse via `readJsonAs<T>`); `toErrorMessage(unknown)` instead of `(e as Error).message`
- **Tests:** `node:test` with `node:assert/strict` only — no test frameworks. Run with `--experimental-strip-types --test`
- **Imports:** use `node:` prefix for builtins (`node:fs/promises`, `node:path`, `node:url`)
- **No npm runtime deps** — only devDependencies (oxlint, oxfmt, typescript, @types/node)

## Key files

- `scrape.ts` — single entry point; exports pure functions for testing
- `scrape.test.ts` — unit tests for all pure functions
- `.github/pkl/` — PKL sources for CI workflows; **edit these, not the generated YAML**
- `.cache/courts.json` — cached court list (gitignored, 7-day TTL)
- `output/` — scraped files (gitignored)
