import { expect, type Page } from "@playwright/test";
import { LoginPage } from "./login-page";
import { ProjectRoutePage } from "./project-route-page";
import { assertPageUrl } from "./page-url";

export class InvitePage {
  constructor(readonly page: Page) {}

  static async fromPage(page: Page): Promise<InvitePage> {
    await assertPageUrl(page, (url) => url.pathname.startsWith("/invite/"));
    return new InvitePage(page);
  }

  async clickSignInToAccept(): Promise<LoginPage> {
    await this.page
      .getByRole("button", { name: "Sign in to accept this invite" })
      .click();
    return LoginPage.fromPage(this.page);
  }

  async submitAccept(): Promise<InvitePage> {
    await this.page.getByRole("button", { name: "Accept Invite" }).click();
    return this;
  }

  async accept(): Promise<ProjectRoutePage> {
    await this.submitAccept();
    return ProjectRoutePage.fromPage(this.page);
  }

  async expectAcceptVisible(): Promise<InvitePage> {
    await expect(
      this.page.getByRole("button", { name: "Accept Invite" }),
    ).toBeVisible();
    return this;
  }

  async expectAlreadyAccepted(): Promise<InvitePage> {
    await expect(
      this.page.getByRole("heading", {
        name: "This invite has already been accepted",
      }),
    ).toBeVisible();
    return this;
  }

  async expectWrongAccountWarning(): Promise<InvitePage> {
    await expect(
      this.page.getByText(/this invite was sent to a different email address/i),
    ).toBeVisible();
    await expect(
      this.page.getByRole("button", { name: "Sign out and try again" }),
    ).toBeVisible();
    return this;
  }

  async expectSingleUseClaimMessage(): Promise<InvitePage> {
    await expect(
      this.page.getByText(
        /first signed-in user who accepts it will join the project/i,
      ),
    ).toBeVisible();
    return this;
  }
}
