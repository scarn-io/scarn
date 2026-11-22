import { expect, type Locator, type Page } from "@playwright/test";
import { ProjectTabsBar } from "../components/project-tabs-bar";
import { assertPageUrl } from "./page-url";
import { type ProjectRouteLocation, parseProjectRoute } from "./project-route";

const PROJECT_WORK_ITEMS_URL_PATTERN = /\/[^/]+\/[^/]+\/work-items(?:$|[/?#])/;

export class ProjectWorkItemsPage {
  readonly projectTabs: ProjectTabsBar;
  /** The chip line's free-text box. Chips share this input's container. */
  readonly searchInput: Locator;
  readonly clearFiltersButton: Locator;
  readonly fieldFilterButton: Locator;
  /** The `Sort ▾` control's own button. Its accessible name is whichever
   * preset is active — `Sort` when none is — so the pattern covers every
   * state rather than just the initial one. */
  readonly sortButton: Locator;
  /** The sort popover's axis row for `axis`, once `sortButton` is open. */
  readonly sortAxisOption: (axis: "Created" | "Updated" | "Score") => Locator;
  /** The sort popover's direction row for `label`, once an axis is picked. */
  readonly sortDirectionOption: (label: string) => Locator;
  /** Absent for a viewer who lacks
   * `work-item-platform-comment:create` (decisions 8/9). */
  readonly awaitingApprovalButton: Locator;
  /** The popover's single toggle item, once `awaitingApprovalButton` is open. */
  readonly awaitingApprovalMenuItem: Locator;

  constructor(
    readonly page: Page,
    readonly location: ProjectRouteLocation,
  ) {
    this.projectTabs = new ProjectTabsBar(page, location);
    this.searchInput = page.getByLabel("Search work items");
    this.clearFiltersButton = page.getByRole("button", {
      name: "Clear filters",
    });
    this.fieldFilterButton = page.getByRole("button", { name: /^Field/ });
    this.sortButton = page.getByRole("button", {
      name: /^(Sort|Newest|Oldest|Recently updated|Least recently updated)$/,
    });
    this.sortAxisOption = (axis) =>
      page.getByRole("button", { name: axis, exact: true });
    this.sortDirectionOption = (label) =>
      page.getByRole("button", { name: label, exact: true });
    this.awaitingApprovalButton = page.getByRole("button", {
      name: "Awaiting approval",
    });
    this.awaitingApprovalMenuItem = page.getByRole("button", {
      name: "Has a draft awaiting approval",
    });
  }

  static async fromPage(page: Page): Promise<ProjectWorkItemsPage> {
    await assertPageUrl(page, PROJECT_WORK_ITEMS_URL_PATTERN);
    const location = parseProjectRoute(page);
    return new ProjectWorkItemsPage(page, location);
  }

  /** A filter chip by the label `describeFilter` renders for it. */
  chip(label: string): Locator {
    return this.page.getByText(label, { exact: true });
  }

  /**
   * The `Awaiting approval` badge on the table row for the item titled
   * `title` — the same icon/label pair the detail page's draft card renders,
   * scoped to that row so it can't be confused with the strip's control
   * button of the same name.
   */
  awaitingApprovalBadge(title: string): Locator {
    return this.page
      .getByRole("row", { name: new RegExp(title) })
      .getByText(/^Awaiting approval/);
  }

  /**
   * The chip's remove button, labelled the way the filter model describes it.
   * Exact, because MUI makes a deletable chip's own root a `button` too, whose
   * accessible name concatenates the chip label and this button's.
   */
  removeChipButton(label: string): Locator {
    return this.page.getByRole("button", {
      name: `Remove ${label} filter`,
      exact: true,
    });
  }

  /** Commits the free-text clause the way a user does: type, then Enter. */
  async searchFor(text: string): Promise<void> {
    await this.searchInput.fill(text);
    await this.searchInput.press("Enter");
  }

  async expectQueryParam(param: string, value: string): Promise<void> {
    await expect
      .poll(() => new URL(this.page.url()).searchParams.get(param))
      .toBe(value);
  }

  async expectNoQueryParam(param: string): Promise<void> {
    await expect
      .poll(() => new URL(this.page.url()).searchParams.get(param))
      .toBeNull();
  }
}
