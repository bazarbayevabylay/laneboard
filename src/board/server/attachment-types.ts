// Which attachments the web board shows inline (ADR-0001 §31): raster images only, by the extension of the stored name. Shared by
// the server (Content-Type and Content-Disposition) and the UI (preview or download), so both always agree; no Node imports here.

// The only types ever sent inline. Everything else (html, svg, pdf, text …) is a download as application/octet-stream:
// the board never lets a browser render or run a stored file, and never trusts the stored `mime` (attach maps .html and .svg too).
export const INLINE_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Content type of an attachment that may be shown inline, by the name's extension (any case); null = download only.
export function inlineImageType(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot).toLowerCase();
  return Object.hasOwn(INLINE_IMAGE_TYPES, ext) ? (INLINE_IMAGE_TYPES[ext] ?? null) : null;
}
