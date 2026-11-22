import { expect, test } from "@playwright/test";
import { InvitePage } from "./models/pages/invite-page";
import { LoginPage } from "./models/pages/login-page";
import { createLoggedInContext } from "./support/create-logged-in-context";
import { goToPage } from "./support/go-to-page";

test("accepts a single-use unrestricted invite link with the first authenticated user", async ({
  browser,
  page,
}, testInfo) => {
  test.slow();
  const ownerEmail = `owner-${crypto.randomUUID()}@scarn.local`;
  const claimerEmail = `claimer-${crypto.randomUUID()}@scarn.local`;
  const secondUserEmail = `second-${crypto.randomUUID()}@scarn.local`;

  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  const ownerDashboard = await loginPage.signInAsDevUser(ownerEmail);
  const projectPage = await ownerDashboard.createProject({
    name: "Invite flow unrestricted e2e",
    gitUrl: "https://github.com/example/invite-flow-unrestricted-e2e",
    description: "Covers unrestricted single-use invite acceptance flow.",
  });
  const settingsPage = await projectPage.projectTabs.goToSettings();
  const successPanel = await (
    await settingsPage.openInviteDialog()
  ).createUnrestrictedInvite({ role: "write" });
  const inviteUrl = await successPanel.getInviteUrl();
  expect(inviteUrl).toContain("/invite/");

  const claimerContext = await createLoggedInContext(browser, claimerEmail, {
    harFileName: "invitee-unrestricted-api.har.zip",
    testInfo,
  });
  const claimerInvitePage = await goToPage(
    claimerContext.page,
    InvitePage,
    inviteUrl,
  );
  await claimerInvitePage.expectSingleUseClaimMessage();
  await claimerInvitePage.accept();

  const secondContext = await createLoggedInContext(browser, secondUserEmail);
  const secondInvitePage = await goToPage(
    secondContext.page,
    InvitePage,
    inviteUrl,
  );
  await secondInvitePage.expectAlreadyAccepted();

  await claimerContext.context.close();
  await secondContext.context.close();
});
