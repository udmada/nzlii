# NZLII Scraper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scrape NZSC 2026 decisions from nzlii.org, saving HTML decisions as `.txt` and PDF-embedded decisions as `.pdf`, named `<N> - <Title>.[txt|pdf]`.

**Architecture:** Single `scrape.ts` entry point with no runtime npm dependencies — uses only Node built-in `fetch` and `fs`. Fetches the index page once to discover all case URLs and titles, then processes each sequentially with randomised delay. PDF vs text detection is done by inspecting the HTML of each case page before downloading.

**Tech Stack:** Node 24 (`--experimental-strip-types`), pnpm, oxlint, oxfmt, mise tasks, hk git hooks.

---

### Task 1: Project initialisation

**Files:**

- Modify: `mise.toml`
- Create: `package.json`
- Create: `.gitignore`

**Step 1: Update `mise.toml` to declare pnpm and node**

Replace the contents of `mise.toml` with:

```toml
[tools]
"github:projectdiscovery/katana" = "latest"
node = "24"
pnpm = "latest"

[tasks.scrape]
description = "Run the NZLII scraper"
run = "node --experimental-strip-types scrape.ts"

[tasks.lint]
description = "Lint with oxlint (type-aware)"
run = "pnpm oxlint --tsconfig tsconfig.json ."

[tasks.typecheck]
description = "Type-check with tsc"
run = "pnpm tsc --noEmit"

[tasks.fmt]
description = "Format with oxfmt"
run = "pnpm oxfmt ."

[tasks."fmt:check"]
description = "Check formatting (CI)"
run = "pnpm oxfmt --check ."
```

**Step 2: Initialise pnpm project**

```bash
mise exec -- pnpm init
```

This creates `package.json`. Then set it to `"type": "module"` and add dev deps:

```bash
mise exec -- pnpm add -D oxlint oxfmt typescript
```

Final `package.json` should look like:

```json
{
  "name": "nzill",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "scrape": "node --experimental-strip-types scrape.ts",
    "lint": "oxlint --tsconfig tsconfig.json .",
    "fmt": "oxfmt .",
    "fmt:check": "oxfmt --check .",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "oxlint": "latest",
    "oxfmt": "latest",
    "typescript": "latest"
  }
}
```

**Step 3a: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["scrape.ts"]
}
```

**Step 3: Create `.gitignore`**

```
node_modules/
output/
```

**Step 4: Verify tools resolve**

```bash
mise exec -- pnpm oxlint --version
mise exec -- pnpm oxfmt --version
```

Expected: both print version numbers without error.

**Step 5: Commit**

```bash
git add mise.toml package.json pnpm-lock.yaml tsconfig.json .gitignore
git commit -m "chore: initialise node project with pnpm, oxlint, oxfmt, typescript"
```

---

### Task 2: Set up hk git hooks

**Files:**

- Create: `hk.toml`

**Step 1: Check hk is available**

```bash
hk --version
```

Expected: `hk 1.38.0` (already on PATH).

**Step 2: Create `hk.toml`**

```toml
[hooks.pre-commit]
  [hooks.pre-commit.typecheck]
  run = "mise run typecheck"
  glob = ["*.ts"]

  [hooks.pre-commit.lint]
  run = "mise run lint"
  glob = ["*.ts", "*.js"]

  [hooks.pre-commit.fmt-check]
  run = "mise run fmt:check"
  glob = ["*.ts", "*.js"]
```

**Step 3: Install hooks**

```bash
hk install
```

Expected: creates `.git/hooks/pre-commit`.

**Step 4: Commit**

```bash
git add hk.toml
git commit -m "chore: add hk git hooks for lint and format check"
```

---

### Task 3: Implement `scrape.ts`

**Files:**

- Create: `scrape.ts`

**Step 1: Create `scrape.ts`**

```typescript
// scrape.ts
// Run: mise run scrape [COURT] [YEAR]
// Example: node --experimental-strip-types scrape.ts NZSC 2026

import fs from "fs/promises";
import path from "path";

const COURT = process.argv[2] ?? "NZSC";
const YEAR = process.argv[3] ?? "2026";
const BASE = `https://www.nzlii.org/nz/cases/${COURT}/${YEAR}`;
const INDEX_URL = `${BASE}/`;
const OUTPUT_DIR = path.join("output", COURT, YEAR);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(): Promise<void> {
  // 1000–4000ms randomised delay
  return sleep(1000 + Math.random() * 3000);
}

/** Extract (caseNum, rawTitle, relativeUrl) from the index page HTML */
function parseCaseLinks(html: string): Array<{ num: string; title: string; url: string }> {
  // Match: <a href="../2026/N.html">Title text</a>
  const pattern = /<a\s[^>]*href="[^"]*\/(\d+)\.html"[^>]*>([^<]+)<\/a>/gi;
  const results: Array<{ num: string; title: string; url: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const num = match[1];
    const rawTitle = match[2].trim();
    // Skip non-case links (navigation etc) — must have a digit-only filename
    if (!num) continue;
    results.push({
      num,
      title: cleanTitle(rawTitle),
      url: `${BASE}/${num}.html`,
    });
  }
  return results;
}

/**
 * Remove citation suffix from title.
 * "Body Corporate 207624 v Grimshaw & Co [2026] NZSC 5 (17 February 2026)"
 * → "Body Corporate 207624 v Grimshaw & Co"
 */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*\[\d{4}\]\s+\w+\s+\d+.*$/, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
}

/** Detect embedded PDF in page HTML. Returns relative PDF path or null. */
function detectPdf(html: string): string | null {
  // <object data="/nz/cases/NZSC/2026/4.pdf" ...>
  // <embed src="...pdf" ...>
  const patterns = [
    /<object[^>]+data="([^"]+\.pdf)"[^>]*>/i,
    /<embed[^>]+src="([^"]+\.pdf)"[^>]*>/i,
    /<iframe[^>]+src="([^"]+\.pdf)"[^>]*>/i,
  ];
  for (const pat of patterns) {
    const m = pat.exec(html);
    if (m) return m[1];
  }
  return null;
}

/** Resolve a possibly root-relative URL against the site origin. */
function resolveUrl(href: string): string {
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://www.nzlii.org${href}`;
  return `${BASE}/${href}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`Fetching index: ${INDEX_URL}`);
  const indexHtml = await fetchText(INDEX_URL);
  const cases = parseCaseLinks(indexHtml);

  console.log(`Found ${cases.length} case(s)`);
  if (cases.length === 0) return;

  for (const { num, title, url } of cases) {
    await randomDelay();
    console.log(`\n[${num}] ${title}`);

    try {
      const pageHtml = await fetchText(url);
      const pdfHref = detectPdf(pageHtml);

      if (pdfHref) {
        const pdfUrl = resolveUrl(pdfHref);
        const dest = path.join(OUTPUT_DIR, `${num} - ${title}.pdf`);
        const data = await fetchBinary(pdfUrl);
        await fs.writeFile(dest, data);
        console.log(`  -> PDF: ${dest}`);
      } else {
        const txtUrl = resolveUrl(`${num}.txt`);
        const text = await fetchText(txtUrl);
        const dest = path.join(OUTPUT_DIR, `${num} - ${title}.txt`);
        await fs.writeFile(dest, text, "utf-8");
        console.log(`  -> TXT: ${dest}`);
      }
    } catch (err) {
      console.error(`  ERROR: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

**Step 2: Lint and format**

```bash
mise run lint
mise run fmt
```

Fix any issues reported.

**Step 3: Commit**

```bash
git add scrape.ts
git commit -m "feat: add NZLII decision scraper"
```

---

### Task 4: Smoke test against live site

**Step 1: Run against NZSC 2026**

```bash
mise run scrape NZSC 2026
```

Expected:

- Prints index URL, case count
- For each case: prints `[N] Title` and either `-> PDF: ...` or `-> TXT: ...`
- Files appear in `output/NZSC/2026/`

**Step 2: Spot-check a `.txt` file**

```bash
head -40 "output/NZSC/2026/5 - Body Corporate 207624 v Grimshaw & Co.txt"
```

Expected: readable plain-text judgment content.

**Step 3: Spot-check a PDF case**

```bash
ls -lh "output/NZSC/2026/4 - Dunstan.pdf"
```

Expected: file exists and is non-zero size.

**Step 4: Commit output manifest (optional)**

The `output/` directory is gitignored. No commit needed.
