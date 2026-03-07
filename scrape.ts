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
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/178.0.0.0 Safari/537.36",
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

/** Extract (caseNum, rawTitle, relativeUrl) from the index page HTML */
function parseCaseLinks(html: string): Array<{ num: string; title: string; url: string }> {
  // Match: <a href="../2026/N.html">Title text</a>
  const pattern = /<a\s[^>]*href="[^"]*\/(\d+)\.html"[^>]*>([^<]+)<\/a>/gi;
  const results: Array<{ num: string; title: string; url: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const num = match[1];
    const rawTitle = match[2]?.trim();
    if (!num || rawTitle === undefined) continue;
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

/** Detect embedded PDF in page HTML. Returns href or null. */
function detectPdf(html: string): string | null {
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
