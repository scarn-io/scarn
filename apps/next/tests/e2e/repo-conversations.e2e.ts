import { expect, test } from "@playwright/test";
import { LoginPage } from "./models/pages/login-page";
import { projectRoutePath } from "./models/pages/project-route";
import { goToPage } from "./support/go-to-page";

/**
 * A member starts a Task about the project from the Runs tab's Tasks and
 * deletes it. No worker runs here, so its conversation stays queued with its
 * commit unresolved.
 */
test("a member starts a Task about the project, sees it queued, then deletes it", async ({
  page,
}) => {
  test.slow();
  const question = `Where is checkout handled? ${crypto.randomUUID()}`;
  const login = await goToPage(page, LoginPage, LoginPage.path());
  const dashboard = await login.signInAsDevUser(
    `repo-conversations-${crypto.randomUUID()}@scarn.local`,
  );
  const project = await dashboard.createProject({
    name: "Repo conversations e2e",
    description: "Ask about the repo",
    gitUrl: "https://github.com/example/repo-conversations-e2e",
  });
  const runsPath = `${projectRoutePath(project.location)}/runs`;
  const tasksUrl = `${runsPath}?whatRan=task`;
  const isTasksList = (url: URL) =>
    url.pathname === runsPath && url.searchParams.get("whatRan") === "task";

  await project.projectTabs.goToRuns();
  await page.getByRole("link", { name: /^Tasks/u }).click();
  await page.waitForURL(isTasksList);
  await page.getByRole("button", { name: /New task/u }).click();
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Start task" }).click();

  await page.waitForURL(new RegExp(`${runsPath}/tasks/[0-9a-f-]{36}$`, "u"));
  const taskPath = new URL(page.url()).pathname;
  await expect(page.getByTestId("chat-transcript")).toContainText(question);
  await expect(page.getByText("Queued", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Resolved when execution starts/u)).toBeVisible();

  await page.goto(tasksUrl);
  const row = page.getByRole("link", { name: question });
  await expect(row).toBeVisible();

  await page.goto(taskPath);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Deleted conversations can't be recovered.",
  );
  await dialog.getByRole("button", { name: "Delete conversation" }).click();

  await expect(page).toHaveURL((url) => url.pathname === runsPath);
  await expect(page.getByText(question)).toHaveCount(0);
});
