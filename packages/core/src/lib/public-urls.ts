/**
 * Resolves the public URLs the API knows about: the app's (`APP_URL`) and its
 * own (`API_URL`). Without an API URL the API is served from the app's origin,
 * so `apiBaseUrl` falls back to `${appUrl}/api`. Trailing slashes are dropped
 * and blank values count as unset.
 */
export const resolvePublicUrls = (input: {
  appUrl: string | null | undefined;
  apiUrl: string | null | undefined;
}): { appUrl: string | null; apiBaseUrl: string | null } => {
  const appUrl = normalizeUrl(input.appUrl);
  const apiOrigin = normalizeUrl(input.apiUrl) ?? appUrl;
  return {
    appUrl,
    apiBaseUrl: apiOrigin ? `${apiOrigin}/api` : null,
  };
};

const normalizeUrl = (url: string | null | undefined): string | null => {
  const trimmed = url?.trim().replace(/\/+$/u, "");
  return trimmed ? trimmed : null;
};
