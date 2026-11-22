import type { Page } from "@playwright/test";
import {
  projectRoutePath,
  type ProjectRouteLocation,
} from "../pages/project-route";
import { ProjectSettingsPage } from "../pages/project-settings-page";
import { ProjectWorkItemsPage } from "../pages/project-work-items-page";

export class ProjectTabsBar {
  constructor(
    readonly page: Page,
    readonly location: ProjectRouteLocation,
  ) {}

  async goToSettings(): Promise<ProjectSettingsPage> {
    await this.page.getByRole("tab", { name: "Settings" }).click();
    return ProjectSettingsPage.fromPage(this.page);
  }

  /** Opens the Runs tab (pipeline runs and Tasks) and waits for its URL. */
  async goToRuns(): Promise<void> {
    const runsPath = `${projectRoutePath(this.location)}/runs`;
    await this.page.getByRole("tab", { name: "Runs" }).click();
    await this.page.waitForURL((url) => url.pathname === runsPath);
  }

  async goToWorkItems(): Promise<ProjectWorkItemsPage> {
    await this.page.getByRole("tab", { name: "Work Items" }).click();
    return ProjectWorkItemsPage.fromPage(this.page);
  }
}
