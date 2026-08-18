import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "./html-to-markdown.ts";

describe("htmlToMarkdown", () => {
  test("keeps a link whole, address and all", () => {
    const out = htmlToMarkdown('<p>See <a href="https://example.com/x">the guide</a>.</p>');
    expect(out).toContain("[the guide](https://example.com/x)");
  });

  test("turns headings and lists into their markdown form", () => {
    const out = htmlToMarkdown("<h2>Setup</h2><ul><li>first</li><li>second</li></ul>");
    expect(out).toContain("## Setup");
    expect(out).toContain("- first");
    expect(out).toContain("- second");
  });

  // The reason the tool converts at all: a page is mostly markup, and every
  // byte of a tool result is resent on each later inference of the run.
  test("drops the markup that is not content", () => {
    const html = `
      <html><head><title>t</title><style>.a{color:red}</style></head>
      <body><script>alert(1)</script><p>The actual sentence.</p></body></html>`;
    const out = htmlToMarkdown(html);
    expect(out).toContain("The actual sentence.");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("color:red");
  });

  // From a real page: DuckDuckGo's results carry a country dropdown, and
  // without dropping it the conversion opened with two hundred country names
  // before reaching the first result.
  test("drops form controls, which are never prose", () => {
    const html = '<select><option>Argentina</option><option>Australia</option></select><p>Results</p>';
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("Argentina");
    expect(out).toContain("Results");
  });

  test("decodes entities, named and numeric", () => {
    expect(htmlToMarkdown("<p>a &amp; b &lt; c &#82;&#x53;</p>")).toBe("a & b < c RS");
  });

  test("keeps code as code", () => {
    expect(htmlToMarkdown("<p>Run <code>bun test</code></p>")).toContain("`bun test`");
    expect(htmlToMarkdown("<pre>line one\nline two</pre>")).toContain("```");
  });

  test("names an image by its alt text rather than dropping it silently", () => {
    expect(htmlToMarkdown('<img src="/a.png" alt="the architecture">')).toContain("[image: the architecture]");
  });

  test("does not run paragraphs together", () => {
    const out = htmlToMarkdown("<p>First.</p><p>Second.</p>");
    expect(out).toBe("First.\n\nSecond.");
  });

  // Losing formatting is acceptable; losing the words is not.
  test("keeps the text of a construct it does not understand", () => {
    expect(htmlToMarkdown("<marquee>still readable</marquee>")).toContain("still readable");
  });

  test("leaves text with no markup alone", () => {
    expect(htmlToMarkdown("just a sentence")).toBe("just a sentence");
  });
});
