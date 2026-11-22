import type { Page } from "@playwright/test";
import { DashboardPage } from "./dashboard-page";
import { ProjectWorkItemsPage } from "./project-work-items-page";
import { assertPageUrl } from "./page-url";

export class ProjectsPage {
  constructor(readonly page: Page) {}

  static path(): string {
    return "/";
  }

  static async fromPage(page: Page): Promise<ProjectsPage> {
    await assertPageUrl(page, (url) => url.pathname === "/");
    return new ProjectsPage(page);
  }

  // The dashboard is a list of rows, each headed by a link with the project's
  // name that opens its work-items tab.
  async openProject(projectName: string): Promise<ProjectWorkItemsPage> {
    await this.page
      .getByRole("link", { name: projectName, exact: true })
      .first()
      .click();
    return ProjectWorkItemsPage.fromPage(this.page);
  }

  async goToDashboard(): Promise<DashboardPage> {
    return DashboardPage.fromPage(this.page);
  }
}
