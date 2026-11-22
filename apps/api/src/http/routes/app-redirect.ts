import type { AppContext } from "@scarn/core/lib/di";

/**
 * Browser-facing redirects land on the app (`APP_URL`), which may be a
 * different origin from the API serving the request. Without `APP_URL` the
 * app and API share an origin, so the request's own URL is the base.
 */
export const appOrigin = (appContext: AppContext, request: Request): string =>
  new URL(appContext.appUrl ?? request.url).origin;

/** An app URL for `path` (which may carry a query string) plus `params`. */
export const appRedirectUrl = (
  appContext: AppContext,
  request: Request,
  path: string,
  params: Record<string, string> = {},
): URL => {
  const url = new URL(path, appOrigin(appContext, request));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
};
