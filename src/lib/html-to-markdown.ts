/**
 * html-to-markdown.ts — turns a fetched page into something worth spending
 * tokens on.
 *
 * Raw HTML is mostly not content. A page that reads as a few hundred words
 * arrives as tens of kilobytes of markup, and every byte of it is resent on
 * each later inference of the run. Converting first is not a nicety; it is the
 * difference between a page costing a paragraph and costing a chapter.
 *
 * Deliberately dependency-free, and deliberately not a complete converter. The
 * established libraries need a DOM (`jsdom`) or a browser (`playwright`), which
 * would add tens of megabytes and seconds of startup to a runner whose whole
 * MCP surface is currently one package. What a model needs from a page is its
 * prose, its headings and its links, and that survives a careful pass of
 * regular expressions.
 *
 * Where this is wrong, it is wrong in the safe direction: an unrecognised
 * construct loses its formatting, not its text.
 */

/** Entities common enough in prose to be worth naming; the rest go by code point. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

/**
 * Elements whose content is never prose.
 *
 * `select` and `form` earn their place from a real page: DuckDuckGo's results
 * carry a country dropdown, and without this the conversion opened with two
 * hundred country names before reaching the first result.
 */
const DROPPED = "script|style|noscript|svg|head|select|form|nav|footer|template|iframe|button";

export function htmlToMarkdown(html: string): string {
  let s = html;

  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(new RegExp(`<(${DROPPED})\\b[\\s\\S]*?<\\/\\1>`, "gi"), "");

  // Structure, before tags are stripped wholesale.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `);
  s = s.replace(/<\/h[1-6]>/gi, "\n\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|tr|li|table|section|article|blockquote)>/gi, "\n\n");

  // A link is worth keeping whole: the address is often the point of fetching.
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
    const label = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return label ? `[${label}](${href})` : "";
  });

  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\n\`\`\`\n${code.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code: string) => `\`${code.replace(/<[^>]+>/g, "")}\``);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, "[image: $1]");

  s = s.replace(/<[^>]+>/g, "");

  s = s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(Number(key.slice(1)));
    return match;
  });

  // Collapse the whitespace the markup left behind, without joining paragraphs.
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
