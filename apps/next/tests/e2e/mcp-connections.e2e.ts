import { expect, test, type Page } from "@playwright/test";
import { LoginPage } from "./models/pages/login-page";
import { InvitePage } from "./models/pages/invite-page";
import { createLoggedInContext } from "./support/create-logged-in-context";
import { goToPage } from "./support/go-to-page";

/**
 * The project settings "MCP connections" panel: one card per connection and
 * an "Add connection" menu of presets.
 *
 * The connect flow needs a connection whose server is the loopback fake
 * (`packages/core/tests/connections/support/fake-mcp-oauth.ts`) and the
 * test-only `managedOAuthLoopbackOrigins` DI override letting the API reach it. The e2e
 * web server serves the API from `next start`, whose `AppContext` is built
 * once in `apps/api/src/app.ts` with no overrides, so there is no way to
 * inject the fake there without an env switch (which the plan rules out).
 * That test stays `fixme` until the harness can build the API with the fake.
 */

const SHARED_AUTHORITY_DISCLOSURE =
  "Anyone who can run steps in this project will be able to act in Notion as this account.";

const notionCard = (page: Page) =>
  page.getByRole("region", { name: "Notion connection" });

test.fixme("an admin connects Notion, confirms the candidate, then disconnects", async ({
  page,
}) => {
  test.slow();
  const login = await goToPage(page, LoginPage, LoginPage.path());
  const dashboard = await login.signInAsDevUser(
    `mcp-admin-${crypto.randomUUID()}@scarn.local`,
  );
  const projectPage = await dashboard.createProject({
    name: "MCP connections e2e",
    gitUrl: "https://github.com/example/mcp-connections-e2e",
    description: "Connects a project to the fake Notion provider.",
  });
  await projectPage.projectTabs.goToSettings();

  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByRole("menuitem", { name: "Notion" }).click();
  const connectDialog = page.getByRole("dialog", { name: "Connect Notion" });
  await expect(connectDialog).toContainText(SHARED_AUTHORITY_DISCLOSURE);
  await connectDialog
    .getByRole("button", { name: "Continue to Notion" })
    .click();

  await page.waitForURL(/\/settings\?connection=[0-9a-f-]{36}$/u);
  const confirmCard = page.getByRole("region", {
    name: "Confirm Notion connection",
  });
  await expect(confirmCard).toContainText(SHARED_AUTHORITY_DISCLOSURE);
  await expect(confirmCard).toContainText(
    "Connected as Fake User in Fake Workspace",
  );
  await confirmCard.getByRole("button", { name: "Confirm" }).click();

  await expect(confirmCard).toBeHidden();
  await expect(page).toHaveURL(/\/settings$/u);
  await expect(notionCard(page)).toContainText("Connected");
  await expect(notionCard(page)).toContainText(
    "Connected as Fake User in Fake Workspace",
  );
  await expect(notionCard(page)).toContainText(/Reconnect by /u);

  await notionCard(page).getByRole("button", { name: "Disconnect" }).click();
  const disconnectDialog = page.getByRole("dialog", {
    name: "Disconnect Notion?",
  });
  await disconnectDialog.getByRole("button", { name: "Disconnect" }).click();
  const outcome = page.getByRole("dialog", { name: "Notion disconnected" });
  await expect(outcome).toContainText(
    "Notion accepted Scarn's request to revoke this connection's access.",
  );
  await expect(
    outcome.getByRole("link", { name: "Notion's connections settings" }),
  ).toBeVisible();
  await outcome.getByRole("button", { name: "Done" }).click();
  await expect(notionCard(page)).toContainText("Not connected");
});

test("a member without secrets:write sees the connections panel read-only", async ({
  browser,
  page,
}) => {
  test.slow();
  const login = await goToPage(page, LoginPage, LoginPage.path());
  const dashboard = await login.signInAsDevUser(
    `mcp-owner-${crypto.randomUUID()}@scarn.local`,
  );
  const projectPage = await dashboard.createProject({
    name: "MCP connections read-only e2e",
    gitUrl: "https://github.com/example/mcp-connections-readonly-e2e",
    description: "A writer sees the connections panel without actions.",
  });
  const settingsPage = await projectPage.projectTabs.goToSettings();
  await expect(
    page.getByRole("button", { name: "Add connection" }),
  ).toBeVisible();
  const inviteUrl = await (
    await (
      await settingsPage.openInviteDialog()
    ).createUnrestrictedInvite({ role: "write" })
  ).getInviteUrl();

  const writer = await createLoggedInContext(
    browser,
    `mcp-writer-${crypto.randomUUID()}@scarn.local`,
  );
  const invitePage = await goToPage(writer.page, InvitePage, inviteUrl);
  const writerProject = await invitePage.accept();
  await writerProject.goToSettings();

  await expect(
    writer.page.getByText("This project has no connections yet."),
  ).toBeVisible();
  await expect(
    writer.page.getByText(
      "Only project admins can add, reconnect or disconnect connections.",
    ),
  ).toBeVisible();
  await expect(
    writer.page.getByRole("button", { name: "Add connection" }),
  ).toHaveCount(0);

  await writer.context.close();
});
