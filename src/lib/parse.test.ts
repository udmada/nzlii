import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCourts,
  parseCaseLinks,
  cleanTitle,
  detectPdf,
  resolveUrl,
  extractText,
} from "./parse.ts";

describe("parseCourts", () => {
  it("extracts court codes and names from databases page HTML", () => {
    const html = `<a href="/nz/cases/NZSC/">Supreme Court</a>
                  <a href="/nz/cases/NZCA/">Court of Appeal</a>`;
    assert.deepEqual(parseCourts(html), [
      { code: "NZSC", name: "Supreme Court" },
      { code: "NZCA", name: "Court of Appeal" },
    ]);
  });

  it("returns empty array when no courts found", () => {
    assert.deepEqual(parseCourts("<html></html>"), []);
  });
});

describe("parseCaseLinks", () => {
  it("extracts case num, title, and full url", () => {
    const html = `<a href="/nz/cases/NZSC/2026/1.html">Smith v Jones [2026] NZSC 1</a>`;
    const base = "https://www.nzlii.org/nz/cases/NZSC/2026";
    const links = parseCaseLinks(html, base);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.num, "1");
    assert.equal(links[0]?.title, "Smith v Jones");
    assert.equal(links[0]?.url, `${base}/1.html`);
  });
});

describe("cleanTitle", () => {
  it("strips citation suffix", () => {
    assert.equal(
      cleanTitle("Body Corporate v Grimshaw [2026] NZSC 5 (17 February 2026)"),
      "Body Corporate v Grimshaw",
    );
  });

  it("decodes HTML entities", () => {
    assert.equal(cleanTitle("Smith &amp; Jones"), "Smith & Jones");
  });

  it("replaces unsafe filename chars", () => {
    assert.equal(cleanTitle('Re: "Test"'), "Re_ _Test_");
  });
});

describe("detectPdf", () => {
  it("detects object embed", () => {
    assert.equal(detectPdf(`<object data="/files/case.pdf">`), "/files/case.pdf");
  });

  it("detects embed tag", () => {
    assert.equal(detectPdf(`<embed src="/files/case.pdf">`), "/files/case.pdf");
  });

  it("returns null when no PDF", () => {
    assert.equal(detectPdf("<html><body>text</body></html>"), null);
  });
});

describe("resolveUrl", () => {
  it("returns absolute URLs unchanged", () => {
    assert.equal(
      resolveUrl("https://example.com/file.pdf", "https://base.com"),
      "https://example.com/file.pdf",
    );
  });

  it("prepends origin for root-relative paths", () => {
    assert.equal(
      resolveUrl("/nz/file.pdf", "https://base.com"),
      "https://www.nzlii.org/nz/file.pdf",
    );
  });

  it("appends relative paths to base", () => {
    assert.equal(resolveUrl("file.pdf", "https://base.com/nz"), "https://base.com/nz/file.pdf");
  });
});

describe("extractText", () => {
  it("strips HTML tags and collapses whitespace", () => {
    const html = `<!--make_database header end--><p>Hello   world</p><!--sino noindex-->`;
    const text = extractText(html);
    assert.ok(text.includes("Hello world"));
    assert.ok(!text.includes("<p>"));
  });

  it("decodes common entities", () => {
    const html = `<!--make_database header end-->Smith &amp; Jones &lt;plaintiff&gt;<!--sino noindex-->`;
    assert.ok(extractText(html).includes("Smith & Jones <plaintiff>"));
  });
});
