import { expect, test } from "@playwright/test";
import { LoginPage } from "./models/pages/login-page";
import { ProjectWorkItemsPage } from "./models/pages/project-work-items-page";
import { projectRoutePath } from "./models/pages/project-route";
import { goToPage } from "./support/go-to-page";
import { seedPendingCommentDraft } from "./support/seed-pending-comment-draft";

test("filters and badges work items by a pending agent-drafted comment", async ({
  page,
}) => {
  test.slow();
  const email = `awaiting-approval-${crypto.randomUUID()}@scarn.local`;

  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  const dashboard = await loginPage.signInAsDevUser(email);
  const project = await dashboard.createProject({
    name: "Awaiting approval filter e2e",
    gitUrl: "https://github.com/example/awaiting-approval-filter-e2e",
    description: "Covers the awaiting-approval filter and badge.",
  });
  const workItemsPath = `${projectRoutePath(project.location)}/work-items`;

  // A detail-page URL, distinguished from `/work-items/new` (which already
  // matches a bare `**/work-items/**` glob before the create navigation even
  // happens) by requiring a UUID-shaped final segment.
  const WORK_ITEM_DETAIL_URL_PATTERN =
    /\/work-items\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  // Two items: one that will get a pending draft, one that never does — the
  // filter and the badge both have to tell them apart.
  await page.goto(`${workItemsPath}/new`);
  await page.getByLabel("Add a title").fill("Retry logic drops the last job");
  await page
    .getByLabel("Add a description")
    .fill("The retry backoff never terminates.");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(WORK_ITEM_DETAIL_URL_PATTERN);
  const flaggedWorkItemId = new URL(page.url()).pathname.split("/").at(-1);
  if (!flaggedWorkItemId) throw new Error("Expected a work item id in the URL");

  await page.goto(`${workItemsPath}/new`);
  await page.getByLabel("Add a title").fill("Unrelated housekeeping item");
  await page.getByLabel("Add a description").fill("Nothing pending here.");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(WORK_ITEM_DETAIL_URL_PATTERN);

  const resolveResponse = await page.request.get("/api/projects/resolve", {
    params: {
      username: project.location.username,
      slug: project.location.projectSlug,
    },
  });
  expect(resolveResponse.ok()).toBe(true);
  const { id: projectId } = (await resolveResponse.json()) as { id: string };

  await seedPendingCommentDraft(page, {
    projectId,
    workItemId: flaggedWorkItemId,
    body: "Draft comment awaiting approval for the e2e suite",
  });

  const workItems = await goToPage(page, ProjectWorkItemsPage, workItemsPath);

  // The badge renders on the default, unfiltered view (decision 6/15) — no
  // filter has to be active for the queue to be visible.
  await expect(
    workItems.awaitingApprovalBadge("Retry logic drops the last job"),
  ).toBeVisible();
  await expect(
    workItems.awaitingApprovalBadge("Unrelated housekeeping item"),
  ).toBeHidden();

  await workItems.awaitingApprovalButton.click();
  await workItems.awaitingApprovalMenuItem.click();
  await workItems.expectQueryParam("awaitingApproval", "true");
  await expect(workItems.chip("awaiting approval")).toBeVisible();
  await expect(
    workItems.page.getByText("Retry logic drops the last job"),
  ).toBeVisible();
  await expect(
    workItems.page.getByText("Unrelated housekeeping item"),
  ).toBeHidden();

  await workItems.removeChipButton("awaiting approval").click();
  await workItems.expectNoQueryParam("awaitingApproval");
  await expect(
    workItems.page.getByText("Unrelated housekeeping item"),
  ).toBeVisible();
});
