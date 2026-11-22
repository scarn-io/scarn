import type { Page } from "@playwright/test";
import { DashboardPage } from "./dashboard-page";
import { InvitePage } from "./invite-page";
import {
  OnboardingUsernamePage,
  usernameFromEmail,
} from "./onboarding-username-page";
import { assertPageUrl } from "./page-url";

export class LoginPage {
  constructor(readonly page: Page) {}

  static path(callbackUrl?: string): string {
    return callbackUrl
      ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`
      : "/login";
  }

  static async fromPage(page: Page): Promise<LoginPage> {
    await assertPageUrl(page, (url) => url.pathname.startsWith("/login"));
    return new LoginPage(page);
  }

  // Every new user (including dev-login) now starts un-onboarded and is routed
  // to "/onboarding/username". Complete onboarding with a handle derived from
  // the (random) email so it's unique per test, then continue to the dashboard.
  private async submitDevLogin(email: string): Promise<void> {
    await this.page
      .getByRole("form", { name: "Dev login" })
      .getByLabel("Email")
      .fill(email);
    await this.page
      .getByRole("button", { name: "Sign in as this user" })
      .click();
  }

  private async completeOnboarding(email: string): Promise<void> {
    const onboarding = await OnboardingUsernamePage.fromPage(this.page);
    await onboarding.chooseUsername(usernameFromEmail(email));
  }

  async signInAsDevUser(email: string): Promise<DashboardPage> {
    await this.submitDevLogin(email);
    await this.completeOnboarding(email);
    return DashboardPage.fromPage(this.page);
  }

  // Dev login here carries a `callbackUrl` to the (public, non-protected) invite
  // page, so the post-login redirect goes straight there — the onboarding guard
  // (which only fires under the protected layout) never runs. The invitee stays
  // un-onboarded (null username), which is fine for accepting an invite.
  async signInAsDevUserAndReturnToInvite(email: string): Promise<InvitePage> {
    await this.submitDevLogin(email);
    return InvitePage.fromPage(this.page);
  }
}
