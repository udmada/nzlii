# NZLII Court Decision Scraper — Design

## Goal

Scrape NZSC 2026 court decisions from nzlii.org into local files suitable for RAG and LoRA training.

## Output Format

```
output/<COURT>/<YEAR>/<N> - <Party A v Party B>.txt   # HTML decisions
output/<COURT>/<YEAR>/<N> - <Party A v Party B>.pdf   # PDF-embedded decisions
```

Title derived from index page `<a>` link text, stripped of `[YEAR] COURT N (date)` suffix.

## Pipeline

1. Fetch index page (`/nz/cases/NZSC/2026/`) — one request
2. Parse `<li><a>` elements → extract `(caseNum, title, pageUrl)` tuples
3. For each case (sequential, randomised 1–4s delay):
   - Fetch `.html` page
   - Detect `<object data="*.pdf">` or `<embed src="*.pdf">`
   - If PDF: download `N.pdf`, save as `<N> - <title>.pdf`
   - If text: download `N.txt`, save as `<N> - <title>.txt`

## Key Decisions

- **Title from index `<a>` text** — reliable, avoids per-page `<title>` guessing
- **`.txt` direct download** — nzlii pre-provides plain text; no HTML parsing needed
- **No katana** — index is static HTML; one `fetch` suffices
- **No npm deps** — Node built-in `fetch` and `fs` only
- **Cloudflare-friendly headers** — realistic `User-Agent`, sequential requests only

## Project Setup

- Runtime: Node via mise, pnpm for package management
- Linting: oxlint
- Formatting: oxfmt
- Tasks: mise tasks
- Git hooks: hk
