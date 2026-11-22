import { expect, type Page } from "@playwright/test";
import { ProjectSettingsPage } from "../pages/project-settings-page";

export class InviteLinkSuccessPanel {
  constructor(readonly page: Page) {}

  async waitForLoaded(): Promise<InviteLinkSuccessPanel> {
    await expect(this.page.getByLabel("Invite link")).toBeVisible();
    return this;
  }

  async getInviteUrl(): Promise<string> {
    await this.waitForLoaded();
    return this.page.getByLabel("Invite link").inputValue();
  }

  async close(): Promise<ProjectSettingsPage> {
    await this.page.getByRole("button", { name: "Close" }).click();
    return ProjectSettingsPage.fromPage(this.page);
  }
}
