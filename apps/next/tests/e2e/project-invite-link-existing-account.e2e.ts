import { expect, test } from "@playwright/test";
import { InvitePage } from "./models/pages/invite-page";
import { LoginPage } from "./models/pages/login-page";
import { goToPage } from "./support/go-to-page";
import {
  createLoggedInContext,
  apiHarUrlFilter,
} from "./support/create-logged-in-context";

test("accepts an invite link when the invitee already has an account", async ({
  browser,
  page,
}, testInfo) => {
  test.slow();
  const ownerEmail = `owner-${crypto.randomUUID()}@scarn.local`;
  const inviteeEmail = `invitee-${crypto.randomUUID()}@scarn.local`;

  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  const ownerDashboard = await loginPage.signInAsDevUser(ownerEmail);
  const projectPage = await ownerDashboard.createProject({
    name: "Invite flow existing account e2e",
    gitUrl: "https://github.com/example/invite-flow-existing-account-e2e",
    description: "Covers invite link acceptance flow.",
  });
  const settingsPage = await projectPage.projectTabs.goToSettings();
  const inviteDialog = await settingsPage.openInviteDialog();
  const successPanel = await inviteDialog.createRestrictedInvite({
    email: inviteeEmail,
    role: "write",
  });
  const inviteUrl = await successPanel.getInviteUrl();
  expect(inviteUrl).toContain("/invite/");

  const inviteeContext = await createLoggedInContext(browser, inviteeEmail, {
    harFileName: "invitee-api.har.zip",
    testInfo,
    contextOptions: {
      recordHar: {
        path: testInfo.outputPath("invitee-api.har.zip"),
        content: "attach",
        mode: "full",
        urlFilter: apiHarUrlFilter,
      },
    },
  });
  const invitePage = await goToPage(inviteeContext.page, InvitePage, inviteUrl);
  await invitePage.expectAcceptVisible();
  await invitePage.accept();
  const acceptedInvitePage = await goToPage(
    inviteeContext.page,
    InvitePage,
    inviteUrl,
  );
  await acceptedInvitePage.expectAlreadyAccepted();

  await inviteeContext.context.close();
});
