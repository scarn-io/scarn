import { expect, type Page } from "@playwright/test";

type UrlMatcher = RegExp | ((url: URL) => boolean);

const DEFAULT_URL_TIMEOUT = 15_000;

/**
 * Asserts that the current page URL matches `matcher`, producing a clear
 * "expected X but got Y" error instead of a generic timeout when it does not.
 *
 * Uses expect(page).toHaveURL, which polls the current URL and resolves
 * immediately if the URL already matches — no risk of missing a navigation
 * event that completed before this call.
 *
 * @param timeout - Milliseconds to wait. Defaults to 15 000ms. Pass a larger
 *   value for slow operations (e.g. after test.slow() tests that involve
 *   multiple round-trips).
 */
export async function assertPageUrl(
  page: Page,
  matcher: UrlMatcher,
  { timeout = DEFAULT_URL_TIMEOUT }: { timeout?: number } = {},
): Promise<void> {
  try {
    await expect(page).toHaveURL(matcher, { timeout });
  } catch (error) {
    const actual = page.url();
    const expected =
      matcher instanceof RegExp ? String(matcher) : matcher.toString();
    throw new Error(
      `Expected page URL to match ${expected}, but got: ${actual}`,
      { cause: error },
    );
  }
}
