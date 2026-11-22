import { expect, type Page } from "@playwright/test";
import { assertPageUrl } from "./page-url";
import { type ProjectRouteLocation, parseProjectRoute } from "./project-route";
import { InviteCollaboratorDialog } from "../components/invite-collaborator-dialog";
import { ProjectTabsBar } from "../components/project-tabs-bar";

const PROJECT_SETTINGS_URL_PATTERN = /\/[^/]+\/[^/]+\/settings(?:$|[/?#])/;

export class ProjectSettingsPage {
  readonly projectTabs: ProjectTabsBar;

  constructor(
    readonly page: Page,
    readonly location: ProjectRouteLocation,
  ) {
    this.projectTabs = new ProjectTabsBar(page, location);
  }

  static async fromPage(page: Page): Promise<ProjectSettingsPage> {
    await assertPageUrl(page, PROJECT_SETTINGS_URL_PATTERN);
    const location = parseProjectRoute(page);
    return new ProjectSettingsPage(page, location);
  }

  async openInviteDialog(): Promise<InviteCollaboratorDialog> {
    const dialog = this.page.getByRole("dialog", {
      name: "Invite Collaborator",
    });
    await expect(async () => {
      await this.page
        .getByRole("button", { name: "Invite Collaborator" })
        .first()
        .click();
      await expect(dialog).toBeVisible();
    }).toPass({ timeout: 10_000 });

    return new InviteCollaboratorDialog(this.page).waitForLoaded();
  }
}
