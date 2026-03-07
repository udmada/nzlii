import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, detectPdf, resolveUrl, parseCaseLinks, extractText } from "./scrape.ts";

const BASE = "https://www.nzlii.org/nz/cases/NZSC/2026";

void describe("cleanTitle", () => {
  void it("strips citation suffix", () => {
    assert.equal(
      cleanTitle("Body Corporate 207624 v Grimshaw & Co [2026] NZSC 5 (17 February 2026)"),
      "Body Corporate 207624 v Grimshaw & Co",
    );
  });

  void it("strips single-party citation", () => {
    assert.equal(cleanTitle("Deliu [2026] NZSC 2 (10 February 2026)"), "Deliu");
  });

  void it("replaces unsafe filename chars", () => {
    const result = cleanTitle('Smith v Jones "test" [2026] NZSC 1 (1 January 2026)');
    assert.ok(!result.includes('"'));
  });

  void it("handles title with no suffix", () => {
    assert.equal(cleanTitle("Smith v Jones"), "Smith v Jones");
  });
});

void describe("detectPdf", () => {
  void it("detects object tag", () => {
    const html = '<object data="/nz/cases/NZSC/2026/4.pdf" type="application/pdf"></object>';
    assert.equal(detectPdf(html), "/nz/cases/NZSC/2026/4.pdf");
  });

  void it("detects embed tag", () => {
    const html = '<embed src="/nz/cases/NZSC/2026/4.pdf" />';
    assert.equal(detectPdf(html), "/nz/cases/NZSC/2026/4.pdf");
  });

  void it("detects iframe tag", () => {
    const html = '<iframe src="/nz/cases/NZSC/2026/4.pdf"></iframe>';
    assert.equal(detectPdf(html), "/nz/cases/NZSC/2026/4.pdf");
  });

  void it("returns null when no PDF", () => {
    assert.equal(detectPdf("<p>Hello</p>"), null);
  });
});

void describe("resolveUrl", () => {
  void it("passes through absolute URLs", () => {
    assert.equal(resolveUrl("https://example.com/file.pdf", BASE), "https://example.com/file.pdf");
  });

  void it("resolves root-relative URLs", () => {
    assert.equal(
      resolveUrl("/nz/cases/NZSC/2026/4.pdf", BASE),
      "https://www.nzlii.org/nz/cases/NZSC/2026/4.pdf",
    );
  });

  void it("resolves relative URLs against base", () => {
    assert.equal(resolveUrl("5.txt", BASE), "https://www.nzlii.org/nz/cases/NZSC/2026/5.txt");
  });
});

void describe("extractText", () => {
  void it("extracts body between nzlii markers", () => {
    const html = `
      <nav>nav stuff</nav>
      <!--make_database header end-->
      <p>Judgment paragraph one.</p>
      <p>Judgment paragraph two.</p>
      <!--sino noindex-->
      <footer>footer</footer>
    `;
    const text = extractText(html);
    assert.ok(text.includes("Judgment paragraph one."));
    assert.ok(text.includes("Judgment paragraph two."));
    assert.ok(!text.includes("nav stuff"));
    assert.ok(!text.includes("footer"));
  });

  void it("decodes HTML entities", () => {
    const html = "<!--make_database header end--><p>Smith &amp; Jones</p><!--sino noindex-->";
    assert.ok(extractText(html).includes("Smith & Jones"));
  });

  void it("falls back to full html when markers absent", () => {
    const text = extractText("<p>Hello world</p>");
    assert.ok(text.includes("Hello world"));
  });

  void it("strips script and style content", () => {
    const html =
      "<!--make_database header end--><script>alert(1)</script><p>Clean</p><!--sino noindex-->";
    const text = extractText(html);
    assert.ok(!text.includes("alert"));
    assert.ok(text.includes("Clean"));
  });
});

void describe("parseCaseLinks", () => {
  const indexHtml = `
    <ul>
      <li><a href="../2026/1.html">Jones v Family Court [2026] NZSC 1 (11 February 2026)</a></li>
      <li><a href="../2026/2.html">Deliu [2026] NZSC 2 (10 February 2026)</a></li>
    </ul>
    <a href="/databases.html">Databases</a>
  `;

  void it("extracts case numbers and titles", () => {
    const cases = parseCaseLinks(indexHtml, BASE);
    assert.equal(cases.length, 2);
    assert.equal(cases[0]?.num, "1");
    assert.equal(cases[0]?.title, "Jones v Family Court");
    assert.equal(cases[1]?.num, "2");
    assert.equal(cases[1]?.title, "Deliu");
  });

  void it("builds correct URLs", () => {
    const cases = parseCaseLinks(indexHtml, BASE);
    assert.equal(cases[0]?.url, `${BASE}/1.html`);
  });

  void it("ignores non-case links", () => {
    const cases = parseCaseLinks(indexHtml, BASE);
    assert.ok(cases.every((c) => /^\d+$/.test(c.num)));
  });

  void it("returns empty array for empty page", () => {
    assert.deepEqual(parseCaseLinks("<html></html>", BASE), []);
  });
});
