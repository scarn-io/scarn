import type { Page } from "@playwright/test";
import { ProjectsPage } from "./projects-page";
import { ProjectSettingsPage } from "./project-settings-page";
import { ProjectWorkItemsPage } from "./project-work-items-page";
import { type ProjectRouteLocation, projectRoutePath } from "./project-route";
import { assertPageUrl } from "./page-url";

export class DashboardPage {
  constructor(readonly page: Page) {}

  static async fromPage(page: Page): Promise<DashboardPage> {
    await assertPageUrl(
      page,
      (url) => url.pathname === "/" || url.pathname === "/dashboard",
    );
    return new DashboardPage(page);
  }

  async goToProjects(): Promise<ProjectsPage> {
    return ProjectsPage.fromPage(this.page);
  }

  async goToProjectSettings(
    location: ProjectRouteLocation,
  ): Promise<ProjectSettingsPage> {
    await this.page.goto(`${projectRoutePath(location)}/settings`);
    return ProjectSettingsPage.fromPage(this.page);
  }

  async createProject(input: {
    name: string;
    gitUrl: string;
    description: string;
  }): Promise<ProjectWorkItemsPage> {
    // Zero-projects dashboards no longer auto-redirect (#154) — they show an
    // empty-state alongside the demo project link instead. Click through to
    // project creation explicitly.
    // The wizard runs Repository URL → Details → Issues; these tests don't
    // need an issue tracker, so the last step is skipped.
    await this.page.getByRole("button", { name: "New project" }).click();
    await this.page.waitForURL("**/projects/new");

    const repositoryStep = this.page.getByRole("form", { name: "Repository" });
    await repositoryStep.getByLabel("Repository URL").fill(input.gitUrl);
    await repositoryStep.getByRole("button", { name: "Continue" }).click();

    const detailsStep = this.page.getByRole("form", { name: "Details" });
    await detailsStep.getByLabel("Project name").fill(input.name);
    await detailsStep.getByLabel("Description").fill(input.description);
    await detailsStep.getByRole("button", { name: "Continue" }).click();

    await this.page.getByRole("button", { name: "Skip for now" }).click();
    return ProjectWorkItemsPage.fromPage(this.page);
  }
}
