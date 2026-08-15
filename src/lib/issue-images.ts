/**
 * issue-images.ts — turns the pictures in an issue into pictures the model sees.
 *
 * A screenshot attached to an issue arrives in the body as a markdown image, so
 * a run that reads the body reads a URL. The model is told a picture exists and
 * is shown its address, which is the one thing it cannot follow.
 *
 * This fetches those images and returns them as MCP content blocks, the shape
 * atoma's LLM adapters already know how to place — the same shape a tool uses
 * when it returns one.
 *
 * Best-effort throughout. An image that cannot be fetched leaves its markdown
 * in the text, which is what the run had before.
 */
import { ghBytes } from "./gh.ts";

/** An image the model can look at, in MCP's content-block shape. */
export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export type ContentBlock = { type: "text"; text: string } | ImageBlock;

/** Largest image to inline, in bytes of base64. */
const MAX_IMAGE_BYTES = 4_000_000;

/** How many images to take from one body. */
const MAX_IMAGES = 4;

const IMAGE_MARKDOWN = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
const IMAGE_HTML = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Image URLs referenced by a body, in the order they appear, deduplicated.
 *
 * Both spellings, because GitHub produces both: the editor writes markdown when
 * a file is dropped in, and people paste `<img>` when they want a width.
 *
 * Capped. A body with thirty screenshots would otherwise put thirty images into
 * every later inference of that run, and the cost is paid per iteration.
 */
export function extractImageUrls(body: string): string[] {
  const urls: string[] = [];
  for (const pattern of [IMAGE_MARKDOWN, IMAGE_HTML]) {
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      const url = match[1];
      if (url && !urls.includes(url)) urls.push(url);
    }
  }
  return urls.slice(0, MAX_IMAGES);
}

/**
 * The media type for a URL, or "" when its extension says nothing.
 *
 * GitHub's own attachment URLs (`user-attachments/assets/<uuid>`) carry no
 * extension, so those fall back to PNG — the format a pasted screenshot takes,
 * and the one every vision model reads.
 */
function mimeTypeFor(url: string): string {
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[extension] ?? "image/png";
}

/**
 * Fetch one image as a block, or undefined if it cannot be had.
 *
 * Through `gh api`, not a bare fetch, because an attachment on a private
 * repository is not public: `gh` carries the run's token and follows the
 * redirect to the signed URL the token earns.
 */
export function fetchImageBlock(url: string): ImageBlock | undefined {
  const { code, stdout } = gh("api", url, "--method", "GET", "--header", "Accept: application/vnd.github.raw");
  if (code !== 0 || !stdout) return undefined;

  const data = Buffer.from(stdout, "binary").toString("base64");
  if (!data || data.length > MAX_IMAGE_BYTES) return undefined;

  return { type: "image", data, mimeType: mimeTypeFor(url) };
}

/**
 * A message's content, with any images it references attached.
 *
 * Returns the text unchanged when there are no images, or none could be
 * fetched — the ordinary case, and the one that must stay a plain string so the
 * sessions written before this look no different from the ones written after.
 */
export function contentWithImages(text: string): string | ContentBlock[] {
  const urls = extractImageUrls(text);
  if (urls.length === 0) return text;

  const images = urls.map(fetchImageBlock).filter((block): block is ImageBlock => block !== undefined);
  if (images.length === 0) return text;

  return [{ type: "text", text }, ...images];
}
