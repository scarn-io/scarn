import { expect, test } from "@playwright/test";
import { LoginPage } from "./models/pages/login-page";
import { ProjectWorkItemsPage } from "./models/pages/project-work-items-page";
import { projectRoutePath } from "./models/pages/project-route";
import { goToPage } from "./support/go-to-page";

test("picks a Created/Oldest sort and round-trips it through the URL", async ({
  page,
}) => {
  test.slow();
  const email = `sort-menu-${crypto.randomUUID()}@scarn.local`;

  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  const dashboard = await loginPage.signInAsDevUser(email);
  const project = await dashboard.createProject({
    name: "Work item sort menu e2e",
    gitUrl: "https://github.com/example/work-item-sort-menu-e2e",
    description: "Covers the work items sort menu.",
  });
  const workItemsPath = `${projectRoutePath(project.location)}/work-items`;

  // A project with no work items at all renders the onboarding empty state
  // instead of the filter bar, so give it something to sort.
  await page.goto(`${workItemsPath}/new`);
  await page.getByLabel("Add a title").fill("Retry loop never terminates");
  await page
    .getByLabel("Add a description")
    .fill("The retry backoff never terminates.");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(`**/work-items/**`);

  const workItems = await goToPage(page, ProjectWorkItemsPage, workItemsPath);
  // No `sort` param is ever in this fresh page's URL, yet the control must
  // never render a blank state: the server's own silent default
  // (`updated`+`desc`) is what the button and popover report (decision 4,
  // `work-item-sort.md`; `work-item-sort-default-state.md`).
  await expect(workItems.sortButton).toHaveText("Recently updated");

  await workItems.sortButton.click();
  await expect(workItems.sortAxisOption("Updated")).toHaveClass(/Mui-selected/);
  await expect(
    workItems.sortDirectionOption("Most recently updated"),
  ).toHaveClass(/Mui-selected/);
  await page.keyboard.press("Escape");

  // Picking the axis alone is a complete pick (it commits with the default
  // direction), and the popover stays open so the direction row underneath is
  // reachable in the same interaction.
  await workItems.sortButton.click();
  await workItems.sortAxisOption("Created").click();
  await workItems.expectQueryParam("sort", "created-desc");

  await workItems.sortDirectionOption("Oldest first").click();
  await workItems.expectQueryParam("sort", "created-asc");

  // The menu never auto-closes on a pick (so a person can chain axis, cascade,
  // and direction choices in one open popover), and MUI's `Popover` hides the
  // rest of the page from the accessibility tree — including the trigger
  // button — while it's open. Close it to read the trigger's label back.
  await page.keyboard.press("Escape");
  await expect(workItems.sortButton).toHaveText("Oldest");

  await page.reload();
  const reloaded = await ProjectWorkItemsPage.fromPage(page);
  await expect(reloaded.sortButton).toHaveText("Oldest");
  await reloaded.expectQueryParam("sort", "created-asc");
});
