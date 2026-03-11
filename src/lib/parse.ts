import type { Court, CaseLink } from "../types.ts";

/** Extract NZ court codes and names from the databases page HTML. */
export const parseCourts = (html: string): readonly Court[] =>
  [...html.matchAll(/href="\/nz\/cases\/([^/]+)\/"[^>]*>([^<]+)<\/a>/gi)].flatMap(
    ([, code, name]) => (code && name ? [{ code, name: name.trim() }] : []),
  );

/** Extract (caseNum, title, url) tuples from the index page HTML. */
export const parseCaseLinks = (html: string, base: string): readonly CaseLink[] =>
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
