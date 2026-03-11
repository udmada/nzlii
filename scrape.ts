// scrape.ts
// Run: mise run scrape [COURT] [YEAR]
// Example: node --experimental-strip-types scrape.ts NZSC 2026
// List courts: node --experimental-strip-types scrape.ts

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATABASES_URL = "https://www.nzlii.org/databases.html";
const COURTS_CACHE_PATH = ".cache/courts.json";
const COURTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- Domain types (immutable) ---

type Court = { readonly code: string; readonly name: string };
type CaseLink = { readonly num: string; readonly title: string; readonly url: string };
type CourtsCache = { readonly fetchedAt: number; readonly courts: readonly Court[] };

// --- Result<T> ---

type Ok<T> = { readonly ok: true; readonly value: T };
type Err = { readonly ok: false; readonly error: string };
type Result<T> = Ok<T> | Err;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (error: string): Err => ({ ok: false, error });

const matchResult = <T, U>(
  result: Result<T>,
  onOk: (value: T) => U,
  onErr: (error: string) => U,
): U => (result.ok ? onOk(result.value) : onErr(result.error));

// --- Type utilities ---

type TypeGuard<T> = (v: unknown) => v is T;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isCourt: TypeGuard<Court> = (v): v is Court =>
  isRecord(v) && typeof v["code"] === "string" && typeof v["name"] === "string";

const isCourtsCache: TypeGuard<CourtsCache> = (v): v is CourtsCache =>
  isRecord(v) &&
  typeof v["fetchedAt"] === "number" &&
  Array.isArray(v["courts"]) &&
  (v["courts"] as unknown[]).every(isCourt);

/** Safely parse a JSON file and narrow to T, returning null on failure or type mismatch. */
const readJsonAs = async <T>(filePath: string, guard: TypeGuard<T>): Promise<T | null> => {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf-8"));
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Extract a message from an unknown thrown value without casting. */
const toErrorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// --- Constants ---

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
} as const;

const CONCURRENCY = 3; // parallel workers
const MIN_FETCH_GAP_MS = 800; // minimum gap between any two HTTP requests
const FETCH_JITTER_MS = 2000; // additional random jitter per request

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Rate limiter ---
//
// Slots are reserved synchronously (before any await), so no two concurrent callers
// can claim the same slot — safe because JS event loop is single-threaded.
let nextFetchMs = 0;

const waitForSlot = async (): Promise<void> => {
  const startAt = Math.max(Date.now(), nextFetchMs);
  nextFetchMs = startAt + MIN_FETCH_GAP_MS + Math.random() * FETCH_JITTER_MS;
  const wait = startAt - Date.now();
  if (wait > 0) await sleep(wait);
};

// --- Pure parsing functions ---

/** Extract NZ court codes and names from the databases page HTML. */
export const parseCourts = (html: string): Court[] =>
  [...html.matchAll(/href="\/nz\/cases\/([^/]+)\/"[^>]*>([^<]+)<\/a>/gi)].flatMap(
    ([, code, name]) => (code != null && name != null ? [{ code, name: name.trim() }] : []),
  );

/** Extract (caseNum, title, url) tuples from the index page HTML. */
export const parseCaseLinks = (html: string, base: string): CaseLink[] =>
  [...html.matchAll(/<a\s[^>]*href="[^"]*\/(\d+)\.html"[^>]*>([^<]+)<\/a>/gi)].flatMap(
    ([, num, rawTitle]) =>
      num != null && rawTitle != null
        ? [{ num, title: cleanTitle(rawTitle.trim()), url: `${base}/${num}.html` }]
        : [],
  );

/**
 * Strip citation suffix and unsafe filename chars from a raw case title.
 * "Body Corporate 207624 v Grimshaw & Co [2026] NZSC 5 (17 February 2026)"
 * → "Body Corporate 207624 v Grimshaw & Co"
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
      ? `https://www.nzlii.org${href}`
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

// --- I/O ---

const fetchText = async (url: string): Promise<string> => {
  await waitForSlot();
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};

const fetchBinary = async (url: string): Promise<Buffer> => {
  await waitForSlot();
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

const getCourts = async (): Promise<readonly Court[]> => {
  const cached = await readJsonAs(COURTS_CACHE_PATH, isCourtsCache);
  if (cached !== null && Date.now() - cached.fetchedAt < COURTS_CACHE_TTL_MS) {
    return cached.courts;
  }
  const courts = parseCourts(await fetchText(DATABASES_URL));
  await fs.mkdir(path.dirname(COURTS_CACHE_PATH), { recursive: true });
  await fs.writeFile(COURTS_CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), courts }, null, 2));
  return courts;
};

// --- Concurrency ---

/**
 * Run `fn` over `items` with at most `limit` concurrent executions.
 * queue.shift() is atomic in single-threaded JS, so no two workers claim the same item.
 */
const runConcurrent = async <T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) await fn(item);
      }
    }),
  );
};

const processCase = async (
  base: string,
  outputDir: string,
  { num, title, url }: CaseLink,
): Promise<Result<string>> => {
  // Resume: skip if any file for this case number already exists in outputDir.
  const existing = await fs
    .readdir(outputDir)
    .then((files) => files.find((f) => f.startsWith(`${num} - `)))
    .catch(() => undefined);
  if (existing != null) return ok(`SKIP (${existing})`);

  try {
    const pageHtml = await fetchText(url);
    const pdfHref = detectPdf(pageHtml);
    if (pdfHref !== null) {
      const dest = path.join(outputDir, `${num} - ${title}.pdf`);
      await fs.writeFile(dest, await fetchBinary(resolveUrl(pdfHref, base)));
      return ok(`PDF: ${dest}`);
    }
    const dest = path.join(outputDir, `${num} - ${title}.txt`);
    await fs.writeFile(dest, extractText(pageHtml), "utf-8");
    return ok(`TXT: ${dest}`);
  } catch (e) {
    return err(toErrorMessage(e));
  }
};

// --- Commands ---

const listCourts = async (): Promise<void> => {
  const courts = await getCourts();
  console.log(`\nAvailable NZ courts (${courts.length}):\n`);
  courts.forEach(({ code, name }) => {
    console.log(`  ${code.padEnd(20)} ${name}`);
  });
  console.log(`\nUsage: mise run scrape <COURT> <YEAR>`);
  console.log(`Example: mise run scrape NZSC 2026`);
};

const scrape = async (court: string, year: string): Promise<void> => {
  const base = `https://www.nzlii.org/nz/cases/${court}/${year}`;
  const outputDir = path.join("output", court, year);
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`Fetching index: ${base}/`);
  const cases = parseCaseLinks(await fetchText(`${base}/`), base);
  console.log(
    `Found ${cases.length} case(s). Workers: ${CONCURRENCY}, gap: ${MIN_FETCH_GAP_MS}–${MIN_FETCH_GAP_MS + FETCH_JITTER_MS}ms`,
  );
  await runConcurrent(cases, CONCURRENCY, async (c) => {
    console.log(`\n[${c.num}] ${c.title}`);
    matchResult(
      await processCase(base, outputDir, c),
      (msg) => {
        console.log(`  -> ${msg}`);
      },
      (msg) => {
        console.error(`  ERROR: ${msg}`);
      },
    );
  });
  console.log(`\nDone. Output: ${outputDir}`);
};

// Only run when executed directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , court, year] = process.argv;
  (court != null && year != null ? scrape(court, year) : listCourts()).catch((e: unknown) => {
    console.error("Fatal:", toErrorMessage(e));
    process.exit(1);
  });
}
