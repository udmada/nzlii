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

type Court = { code: string; name: string };
type CaseLink = { num: string; title: string; url: string };
type CourtsCache = { fetchedAt: number; courts: Court[] };
type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (error: string): Err => ({ ok: false, error });

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const randomDelay = (): Promise<void> => sleep(1000 + Math.random() * 3000);

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

const fetchText = async (url: string): Promise<string> => {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};

const fetchBinary = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

const getCourts = async (): Promise<Court[]> => {
  try {
    const cached = JSON.parse(await fs.readFile(COURTS_CACHE_PATH, "utf-8")) as CourtsCache;
    if (Date.now() - cached.fetchedAt < COURTS_CACHE_TTL_MS) return cached.courts;
  } catch {
    // cache missing or unreadable — fall through to fetch
  }
  const courts = parseCourts(await fetchText(DATABASES_URL));
  await fs.mkdir(path.dirname(COURTS_CACHE_PATH), { recursive: true });
  await fs.writeFile(COURTS_CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), courts }, null, 2));
  return courts;
};

const processCase = async (
  base: string,
  outputDir: string,
  { num, title, url }: CaseLink,
): Promise<Result<string>> => {
  try {
    const pageHtml = await fetchText(url);
    const pdfHref = detectPdf(pageHtml);
    if (pdfHref) {
      const dest = path.join(outputDir, `${num} - ${title}.pdf`);
      await fs.writeFile(dest, await fetchBinary(resolveUrl(pdfHref, base)));
      return ok(`PDF: ${dest}`);
    }
    const dest = path.join(outputDir, `${num} - ${title}.txt`);
    await fs.writeFile(dest, extractText(pageHtml), "utf-8");
    return ok(`TXT: ${dest}`);
  } catch (e) {
    return err((e as Error).message);
  }
};

const listCourts = async (): Promise<void> => {
  const courts = await getCourts();
  console.log(`\nAvailable NZ courts (${courts.length}):\n`);
  courts.forEach(({ code, name }) => console.log(`  ${code.padEnd(20)} ${name}`));
  console.log(`\nUsage: mise run scrape <COURT> <YEAR>`);
  console.log(`Example: mise run scrape NZSC 2026`);
};

const scrape = async (court: string, year: string): Promise<void> => {
  const base = `https://www.nzlii.org/nz/cases/${court}/${year}`;
  const outputDir = path.join("output", court, year);
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`Fetching index: ${base}/`);
  const cases = parseCaseLinks(await fetchText(`${base}/`), base);
  console.log(`Found ${cases.length} case(s)`);
  for (const c of cases) {
    await randomDelay();
    console.log(`\n[${c.num}] ${c.title}`);
    const result = await processCase(base, outputDir, c);
    if (result.ok) console.log(`  -> ${result.value}`);
    else console.error(`  ERROR: ${result.error}`);
  }
  console.log(`\nDone. Output: ${outputDir}`);
};

// Only run when executed directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , court, year] = process.argv;
  (court && year ? scrape(court, year) : listCourts()).catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
