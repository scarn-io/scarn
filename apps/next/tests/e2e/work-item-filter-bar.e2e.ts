import { expect, test } from "@playwright/test";
import { LoginPage } from "./models/pages/login-page";
import { ProjectWorkItemsPage } from "./models/pages/project-work-items-page";
import { projectRoutePath } from "./models/pages/project-route";
import { goToPage } from "./support/go-to-page";

const FIELD_CHIP_LABEL = "priority: P1";

test("adds, reads back, and clears work item filters from the chip line", async ({
  page,
}) => {
  test.slow();
  const email = `filters-${crypto.randomUUID()}@scarn.local`;

  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  const dashboard = await loginPage.signInAsDevUser(email);
  const project = await dashboard.createProject({
    name: "Work item filter bar e2e",
    gitUrl: "https://github.com/example/work-item-filter-bar-e2e",
    description: "Covers the work items filter bar.",
  });
  const workItemsPath = `${projectRoutePath(project.location)}/work-items`;

  // A project with no work items at all renders the onboarding empty state
  // instead of the filter bar, so give it something to filter.
  await page.goto(`${workItemsPath}/new`);
  await page.getByLabel("Add a title").fill("Payment retry loops forever");
  await page
    .getByLabel("Add a description")
    .fill("The retry backoff never terminates.");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(`**/work-items/**`);

  const workItems = await goToPage(page, ProjectWorkItemsPage, workItemsPath);
  await expect(workItems.searchInput).toBeVisible();
  await expect(workItems.clearFiltersButton).toBeHidden();

  // Free text: typed into the box, committed with Enter, and read back out of
  // the URL — the box keeps the text rather than turning it into a chip.
  await workItems.searchFor("payment");
  await workItems.expectQueryParam("q", "payment");
  await expect(workItems.searchInput).toHaveValue("payment");
  await expect(workItems.clearFiltersButton).toBeVisible();

  // A `?f.*` URL predating the new bar still loads, and renders as a chip.
  const shared = await goToPage(
    page,
    ProjectWorkItemsPage,
    `${workItemsPath}?q=payment&f.priority=P1`,
  );
  await expect(shared.chip(FIELD_CHIP_LABEL)).toBeVisible();

  // The chip's remove control is a real focusable button, and it sits before
  // the text box in tab order.
  const removeChip = shared.removeChipButton(FIELD_CHIP_LABEL);
  await removeChip.focus();
  await page.keyboard.press("Tab");
  await expect(shared.searchInput).toBeFocused();

  await removeChip.click();
  await shared.expectNoQueryParam("f.priority");
  await shared.expectQueryParam("q", "payment");
  await expect(shared.chip(FIELD_CHIP_LABEL)).toBeHidden();

  await shared.clearFiltersButton.click();
  await shared.expectNoQueryParam("q");
  await expect(shared.searchInput).toHaveValue("");
  await expect(shared.clearFiltersButton).toBeHidden();
});
