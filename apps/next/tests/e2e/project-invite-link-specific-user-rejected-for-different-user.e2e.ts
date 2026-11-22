import { test } from "@playwright/test";
import { InvitePage } from "./models/pages/invite-page";
import { LoginPage } from "./models/pages/login-page";
import { createLoggedInContext } from "./support/create-logged-in-context";
import { goToPage } from "./support/go-to-page";

test("rejects a restricted invite link for a different signed-in user", async ({
  browser,
  page,
}) => {
  test.slow();
  const ownerEmail = `owner-${crypto.randomUUID()}@scarn.local`;
  const intendedUserEmail = `intended-${crypto.randomUUID()}@scarn.local`;
  const wrongUserEmail = `wrong-${crypto.randomUUID()}@scarn.local`;

  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  const ownerDashboard = await loginPage.signInAsDevUser(ownerEmail);
  const projectPage = await ownerDashboard.createProject({
    name: "Invite flow restricted wrong user e2e",
    gitUrl: "https://github.com/example/invite-flow-restricted-wrong-user-e2e",
    description: "Covers restricted invite rejection for a different user.",
  });
  const settingsPage = await projectPage.projectTabs.goToSettings();
  const successPanel = await (
    await settingsPage.openInviteDialog()
  ).createRestrictedInvite({
    email: intendedUserEmail,
    role: "write",
  });
  const inviteUrl = await successPanel.getInviteUrl();

  const wrongUserContext = await createLoggedInContext(browser, wrongUserEmail);
  const invitePage = await goToPage(
    wrongUserContext.page,
    InvitePage,
    inviteUrl,
  );
  await invitePage.expectAcceptVisible();
  await invitePage.submitAccept();
  await invitePage.expectWrongAccountWarning();

  await wrongUserContext.context.close();
});
