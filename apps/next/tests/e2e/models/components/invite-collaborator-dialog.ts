import { expect, type Locator, type Page } from "@playwright/test";
import { InviteLinkSuccessPanel } from "./invite-link-success-panel";
import { ProjectSettingsPage } from "../pages/project-settings-page";

type InviteRole = "admin" | "write" | "read";

export class InviteCollaboratorDialog {
  constructor(readonly page: Page) {}

  async waitForLoaded(): Promise<InviteCollaboratorDialog> {
    await expect(
      this.page.getByRole("dialog", { name: "Invite Collaborator" }),
    ).toBeVisible();
    return this;
  }

  async createRestrictedInvite(input: {
    email: string;
    role: InviteRole;
  }): Promise<InviteLinkSuccessPanel> {
    const dialog = await this.waitForLoaded();
    const root = dialog.page.getByRole("dialog", {
      name: "Invite Collaborator",
    });
    await root.getByLabel("Email address").fill(input.email);
    await this.selectRole(root, input.role);
    await root.getByRole("button", { name: "Send Invite" }).click();
    return new InviteLinkSuccessPanel(this.page).waitForLoaded();
  }

  async createUnrestrictedInvite(input: {
    role: InviteRole;
  }): Promise<InviteLinkSuccessPanel> {
    const dialog = await this.waitForLoaded();
    const root = dialog.page.getByRole("dialog", {
      name: "Invite Collaborator",
    });
    await root
      .getByRole("radio", { name: "Anyone with the link can claim it" })
      .click();
    await this.selectRole(root, input.role);
    await root.getByRole("button", { name: "Send Invite" }).click();
    return new InviteLinkSuccessPanel(this.page).waitForLoaded();
  }

  async cancel(): Promise<ProjectSettingsPage> {
    const root = this.page.getByRole("dialog", { name: "Invite Collaborator" });
    await root.getByRole("button", { name: "Cancel" }).click();
    return ProjectSettingsPage.fromPage(this.page);
  }

  private async selectRole(root: Locator, role: InviteRole): Promise<void> {
    const roleLabel =
      role === "admin" ? "Admin" : role === "write" ? "Write" : "Read";
    await root.getByLabel("Role").click();
    await this.page
      .getByRole("option", { name: new RegExp(`^${roleLabel}`) })
      .click();
  }
}
