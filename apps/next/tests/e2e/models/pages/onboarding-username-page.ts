import { type Page } from "@playwright/test";
import { assertPageUrl } from "./page-url";

// Turns a dev-login email into a deterministic, schema-valid username unique to
// that email. Test emails are random (e.g. `owner-<uuid>@scarn.local`), so the
// local part carries no PII — this is safe and keeps handles unique across
// parallel tests. `usernameSchema` requires 3-32 lowercase chars with single
// interior hyphens, so we normalize accordingly.
export function usernameFromEmail(email: string): string {
  const localPart = email.split("@")[0] ?? email;
  const normalized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const candidate = `e2e-${normalized}`;
  // Clamp to the 32-char schema max, trimming a trailing hyphen if the slice
  // lands on one.
  return candidate.slice(0, 32).replace(/-+$/g, "");
}

export class OnboardingUsernamePage {
  constructor(readonly page: Page) {}

  static async fromPage(page: Page): Promise<OnboardingUsernamePage> {
    await assertPageUrl(page, (url) =>
      url.pathname.startsWith("/onboarding/username"),
    );
    return new OnboardingUsernamePage(page);
  }

  // The field arrives prefilled with a suggestion derived from the user's
  // GitHub login, name, or email, so it is cleared before typing the requested
  // handle. Clicking waits for the live availability check to enable the
  // button. The card does a full reload to `callbackUrl` once the username is
  // saved (defaults to "/" when the page wasn't reached via a `callbackUrl`
  // query param).
  async chooseUsername(username: string): Promise<void> {
    const field = this.page.getByLabel("Username");
    await field.clear();
    await field.fill(username);
    const continueButton = this.page.getByRole("button", { name: "Continue" });
    await continueButton.click();
  }
}
