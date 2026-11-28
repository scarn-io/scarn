/**
 * Headers for every response the content origin serves (plan Phase 4,
 * decision 13). Every file, whatever its type, gets the sandbox CSP: HTML,
 * SVG and XML run with an opaque origin, so even a mislabeled stored content
 * type cannot reach the content origin's storage or the app.
 */

/** Extension → content type, used when the stored row has none. */
export const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain",
  wasm: "application/wasm",
  pdf: "application/pdf",
  xml: "application/xml",
  csv: "text/csv",
};

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

const isTextType = (mediaType: string): boolean =>
  mediaType.startsWith("text/") ||
  mediaType === "application/json" ||
  mediaType === "application/xml" ||
  mediaType === "image/svg+xml" ||
  mediaType.endsWith("+json") ||
  mediaType.endsWith("+xml");

const withCharset = (contentType: string): string => {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return isTextType(mediaType) && !/;\s*charset=/i.test(contentType)
    ? `${mediaType}; charset=utf-8`
    : contentType;
};

const extensionOf = (fileName: string): string | null => {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
};

/**
 * The content type to serve: the stored one when present, else by file
 * extension; `null` when neither is known (serve as an attachment).
 */
export const resolveContentType = (
  storedContentType: string | null | undefined,
  fileName: string,
): string | null => {
  const stored = storedContentType?.trim();
  if (stored && stored.toLowerCase() !== FALLBACK_CONTENT_TYPE) {
    return withCharset(stored);
  }
  const extension = extensionOf(fileName);
  const byExtension = extension ? CONTENT_TYPE_BY_EXTENSION[extension] : null;
  return byExtension ? withCharset(byExtension) : null;
};

export const buildContentSecurityPolicy = (appOrigin: string): string =>
  [
    "sandbox allow-scripts allow-popups allow-forms allow-downloads",
    "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
    "form-action 'none'",
    `frame-ancestors ${appOrigin}`,
  ].join("; ");

/**
 * The security headers alone, for error pages and other non-file responses.
 *
 * `Cross-Origin-Resource-Policy` is `cross-origin`: the sandbox CSP gives a
 * bundle page an opaque origin, so its own `<img>` / `<video>` requests are
 * cross-site and `same-site` would block them. Files are already readable
 * from anywhere through `Access-Control-Allow-Origin: *`.
 */
export const contentSecurityHeaders = (
  appOrigin: string,
): Record<string, string> => ({
  "Content-Security-Policy": buildContentSecurityPolicy(appOrigin),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "private, no-store",
});

const attachmentDisposition = (fileName: string): string => {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1) || "download";
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
};

/**
 * The full header set for a served file. `fileName` is the file's path in
 * the bundle; only its extension and base name are used.
 */
export const contentResponseHeaders = (input: {
  appOrigin: string;
  contentType: string | null | undefined;
  fileName: string;
}): Record<string, string> => {
  const contentType = resolveContentType(input.contentType, input.fileName);
  return {
    ...contentSecurityHeaders(input.appOrigin),
    "Content-Type": contentType ?? FALLBACK_CONTENT_TYPE,
    ...(contentType
      ? {}
      : { "Content-Disposition": attachmentDisposition(input.fileName) }),
  };
};
