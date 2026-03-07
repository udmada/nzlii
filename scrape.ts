// scrape.ts
// Run: mise run scrape [COURT] [YEAR]
// Example: node --experimental-strip-types scrape.ts NZSC 2026

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const COURT = process.argv[2] ?? "NZSC";
const YEAR = process.argv[3] ?? "2026";
const BASE = `https://www.nzlii.org/nz/cases/${COURT}/${YEAR}`;
const INDEX_URL = `${BASE}/`;
const OUTPUT_DIR = path.join("output", COURT, YEAR);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(): Promise<void> {
  // 1000–4000ms randomised delay
  return sleep(1000 + Math.random() * 3000);
}

/** Extract (caseNum, title, url) tuples from the index page HTML. */
export function parseCaseLinks(
  html: string,
  base: string,
): Array<{ num: string; title: string; url: string }> {
  const pattern = /<a\s[^>]*href="[^"]*\/(\d+)\.html"[^>]*>([^<]+)<\/a>/gi;
  const results: Array<{ num: string; title: string; url: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const num = match[1];
    const rawTitle = match[2]?.trim();
    if (!num || rawTitle === undefined) continue;
    results.push({ num, title: cleanTitle(rawTitle), url: `${base}/${num}.html` });
  }
  return results;
}

/**
 * Strip citation suffix and unsafe filename chars from a raw case title.
 * "Body Corporate 207624 v Grimshaw & Co [2026] NZSC 5 (17 February 2026)"
 * → "Body Corporate 207624 v Grimshaw & Co"
 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*\[\d{4}\]\s+\w+\s+\d+.*$/, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
}

/** Detect embedded PDF in page HTML. Returns the href/src value or null. */
export function detectPdf(html: string): string | null {
  const patterns = [
    /<object[^>]+data="([^"]+\.pdf)"[^>]*>/i,
    /<embed[^>]+src="([^"]+\.pdf)"[^>]*>/i,
    /<iframe[^>]+src="([^"]+\.pdf)"[^>]*>/i,
  ];
  for (const pat of patterns) {
    const m = pat.exec(html);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Resolve a root-relative or relative URL against the site origin. */
export function resolveUrl(href: string, base: string): string {
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://www.nzlii.org${href}`;
  return `${base}/${href}`;
}

/**
 * Extract readable plain text from an nzlii HTML decision page.
 * Strips navigation headers/footers, script/style, then collapses tags to whitespace.
 */
export function extractText(html: string): string {
  // Isolate the judgment body between the nzlii header/footer markers
  const bodyMatch = /<!--make_database header end-->([\s\S]*?)<!--sino noindex-->/i.exec(html);
  const body = bodyMatch?.[1] ?? html;

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
  const cases = parseCaseLinks(indexHtml, BASE);

  console.log(`Found ${cases.length} case(s)`);
  if (cases.length === 0) return;

  for (const { num, title, url } of cases) {
    await randomDelay();
    console.log(`\n[${num}] ${title}`);

    try {
      const pageHtml = await fetchText(url);
      const pdfHref = detectPdf(pageHtml);

      if (pdfHref) {
        const pdfUrl = resolveUrl(pdfHref, BASE);
        const dest = path.join(OUTPUT_DIR, `${num} - ${title}.pdf`);
        const data = await fetchBinary(pdfUrl);
        await fs.writeFile(dest, data);
        console.log(`  -> PDF: ${dest}`);
      } else {
        const text = extractText(pageHtml);
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

// Only run when executed directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
