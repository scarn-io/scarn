import { headers } from "next/headers";

// Set by `proxy.ts` on every page request to the raw pathname + query string,
// since Server Component layouts have no other way to read the full requested
// URL (they only get their own dynamic segment `params`).
export const REQUEST_PATH_HEADER = "x-scarn-request-path";

export const getSingleValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

// A `callbackUrl` is only ever used as a same-origin `redirect()` target, so
// require a leading "/" and fall back to a safe default otherwise — this is
// the one thing standing between an attacker-controlled query param and an
// open redirect.
export const getSafeCallbackUrl = (
  value: string | string[] | undefined,
  fallback = "/",
) => {
  const callbackUrl = getSingleValue(value)?.trim();

  if (!callbackUrl || !callbackUrl.startsWith("/")) {
    return fallback;
  }

  return callbackUrl;
};

// The current request's path + query string, as captured by `proxy.ts`.
// Null if the proxy didn't run (e.g. a route excluded by its matcher).
export async function getCurrentRequestPath(): Promise<string | null> {
  const requestHeaders = await headers();
  return requestHeaders.get(REQUEST_PATH_HEADER);
}

// Where an auth guard should send an unauthenticated visitor: `/login` with
// the current page (whatever it is) preserved as `callbackUrl`, so a
// successful sign-in/signup returns them to the page they originally asked
// for instead of the dashboard.
export async function loginRedirectPath(): Promise<string> {
  const currentPath = await getCurrentRequestPath();
  if (!currentPath) return "/login";
  return `/login?callbackUrl=${encodeURIComponent(currentPath)}`;
}

// Where an auth guard should send a signed-in-but-not-onboarded user: the
// username picker, with the current page preserved as `callbackUrl` so
// finishing onboarding also returns them to their original destination.
export async function onboardingRedirectPath(): Promise<string> {
  const currentPath = await getCurrentRequestPath();
  if (!currentPath || currentPath === "/onboarding/username") {
    return "/onboarding/username";
  }
  return `/onboarding/username?callbackUrl=${encodeURIComponent(currentPath)}`;
}
