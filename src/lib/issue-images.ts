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

/**
 * Largest image to inline, in bytes of base64.
 *
 * Exported because `web__fetch` applies the same ceiling and had its own copy of the
 * number. Diverge and one path inlines an image the other refuses, for a limit that exists
 * to keep one request under a provider's cap.
 */
export const MAX_IMAGE_BYTES = 4_000_000;

/** How many images to take from one body. */
const MAX_IMAGES = 4;

const IMAGE_MARKDOWN = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
const IMAGE_HTML = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;

/**
 * The media type of some image bytes, read from the bytes.
 *
 * Not from the URL. GitHub's own attachments — the ones you get by dropping a
 * file into the comment box — are served from
 * `github.com/user-attachments/assets/<uuid>`, which carries no extension and
 * says nothing about the format. A JPEG announced as a PNG is rejected by the
 * providers that check, so guessing from the address is not good enough.
 *
 * Returns "" for bytes that are not an image format worth sending, which is the
 * signal to skip that attachment rather than send something unreadable.
 */
export function sniffMimeType(bytes: Uint8Array): string {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  // RIFF....WEBP — the size sits between the two markers.
  if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[8 + i] === b)) {
    return "image/webp";
  }
  return "";
}

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
 * Fetch one image as a block, or undefined if it cannot be had.
 *
 * Through `gh api`, not a bare fetch, because an attachment on a private
 * repository is not public: `gh` carries the run's token and follows the
 * redirect to the signed URL the token earns.
 */
export function fetchImageBlock(url: string): ImageBlock | undefined {
  const { code, bytes } = ghBytes("api", url, "--method", "GET", "--header", "Accept: application/vnd.github.raw");
  if (code !== 0 || bytes.length === 0) return undefined;

  const mimeType = sniffMimeType(bytes);
  if (!mimeType) return undefined;

  const data = Buffer.from(bytes).toString("base64");
  if (!data || data.length > MAX_IMAGE_BYTES) return undefined;

  return { type: "image", data, mimeType };
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
