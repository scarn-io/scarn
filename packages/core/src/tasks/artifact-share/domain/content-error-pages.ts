/**
 * The static pages the content origin answers with when it cannot serve a
 * file. Every token failure (unknown, invalid, revoked, deleted, not ready,
 * sharing disabled) is `not_found` with one shared body, so a response never
 * reveals whether a token ever existed; only an expired bundle says so (410).
 * No external assets and nothing from the request is echoed.
 */
export type ContentErrorKind = "not_found" | "expired" | "rate_limited";

const PAGES: Record<
  ContentErrorKind,
  { status: 404 | 410 | 429; title: string; message: string }
> = {
  not_found: {
    status: 404,
    title: "Link not available",
    message: "This link doesn't exist or is no longer shared.",
  },
  expired: {
    status: 410,
    title: "Link expired",
    message: "The artifacts behind this link have expired.",
  },
  rate_limited: {
    status: 429,
    title: "Too many requests",
    message: "This link is getting too many requests. Try again in a minute.",
  },
};

const renderPage = (title: string, message: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;color:#1f2328;background:#f6f8fa}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#59636e}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;

export const contentErrorPage = (
  kind: ContentErrorKind,
): { status: 404 | 410 | 429; html: string } => {
  const page = PAGES[kind];
  return { status: page.status, html: renderPage(page.title, page.message) };
};
