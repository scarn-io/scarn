/**
 * Parses a content-origin request path: `/s/<shareToken>/<path>` for share
 * links and `/p/<previewToken>/<path>` for member previews (plan decision
 * 12). Pure, so the rules can be tested without HTTP.
 *
 * - `/s/<token>/` (bare) serves the bundle's entry page: `path` is null.
 * - `/s/<token>` without the trailing slash redirects to `/s/<token>/`, so
 *   relative links in the entry page resolve inside the bundle.
 * - Any other path is a bundle-relative file path. Each segment is
 *   percent-decoded exactly once; a segment that fails to decode, is empty
 *   (`a//b`, a trailing `/`), is `.` or `..`, or decodes to something holding
 *   `/`, `\` or NUL is refused. There is no directory index and no SPA
 *   fallback.
 */
export type ContentVia = "share" | "preview";

export type ContentRequestTarget =
  | { kind: "file"; via: ContentVia; token: string; path: string | null }
  | { kind: "redirect"; location: string }
  | { kind: "not_found" };

const CONTENT_PATH_PATTERN = /^\/([sp])\/([^/]+)(\/.*)?$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_IN_SEGMENT = /[/\\\0]/;

const NOT_FOUND: ContentRequestTarget = { kind: "not_found" };

const decodeSegment = (segment: string): string | null => {
  if (segment === "") {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (
    decoded === "." ||
    decoded === ".." ||
    decoded === "" ||
    FORBIDDEN_IN_SEGMENT.test(decoded)
  ) {
    return null;
  }
  return decoded;
};

/** `rawPath` is the request URL's pathname, still percent-encoded. */
export const parseContentRequestPath = (
  rawPath: string,
): ContentRequestTarget => {
  const match = CONTENT_PATH_PATTERN.exec(rawPath);
  if (!match) {
    return NOT_FOUND;
  }
  const [, prefix = "", token = "", rest] = match;
  if (!TOKEN_PATTERN.test(token)) {
    return NOT_FOUND;
  }
  const via: ContentVia = prefix === "s" ? "share" : "preview";
  if (rest === undefined) {
    return { kind: "redirect", location: `/${prefix}/${token}/` };
  }
  if (rest === "/") {
    return { kind: "file", via, token, path: null };
  }

  const segments: string[] = [];
  for (const segment of rest.slice(1).split("/")) {
    const decoded = decodeSegment(segment);
    if (decoded === null) {
      return NOT_FOUND;
    }
    segments.push(decoded);
  }
  return { kind: "file", via, token, path: segments.join("/") };
};
