import type { Page } from "@playwright/test";
import { assertPageUrl } from "./page-url";
import {
  type ProjectRouteLocation,
  isProjectRoutePathname,
  parseProjectRoute,
  projectRoutePath,
} from "./project-route";
import { ProjectSettingsPage } from "./project-settings-page";
import { ProjectWorkItemsPage } from "./project-work-items-page";

export class ProjectRoutePage {
  constructor(
    readonly page: Page,
    readonly location: ProjectRouteLocation,
  ) {}

  static async fromPage(page: Page): Promise<ProjectRoutePage> {
    // Match on the URL pathname (Playwright's toHaveURL regex tests the full
    // `http://host/...` URL, so a `^/`-anchored path regex can never match).
    // The first segment must be a project OWNER username, not a reserved
    // top-level route like `/invite/{token}` — otherwise this would resolve
    // immediately on the invite page before the post-accept redirect fires,
    // racing (and aborting) the in-flight accept request.
    await assertPageUrl(page, (url) => isProjectRoutePathname(url.pathname));
    const location = parseProjectRoute(page);
    return new ProjectRoutePage(page, location);
  }

  async goToSettings(): Promise<ProjectSettingsPage> {
    await this.page.goto(`${projectRoutePath(this.location)}/settings`);
    return ProjectSettingsPage.fromPage(this.page);
  }

  async goToWorkItems(): Promise<ProjectWorkItemsPage> {
    await this.page.goto(`${projectRoutePath(this.location)}/work-items`);
    return ProjectWorkItemsPage.fromPage(this.page);
  }
}
