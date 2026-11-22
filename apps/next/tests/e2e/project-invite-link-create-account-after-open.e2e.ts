import { expect, test } from "@playwright/test";
import { InvitePage } from "./models/pages/invite-page";
import { LoginPage } from "./models/pages/login-page";
import { goToPage } from "./support/go-to-page";

test("accepts an invite link when the invitee creates an account after opening the link", async ({
  browser,
  page,
}) => {
  test.slow();
  const ownerEmail = `owner-${crypto.randomUUID()}@scarn.local`;
  const inviteeEmail = `new-invitee-${crypto.randomUUID()}@scarn.local`;

  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  const ownerDashboard = await loginPage.signInAsDevUser(ownerEmail);
  const projectPage = await ownerDashboard.createProject({
    name: "Invite flow create account after open e2e",
    gitUrl:
      "https://github.com/example/invite-flow-create-account-after-open-e2e",
    description: "Covers invite flow when invitee signs up after opening link.",
  });
  const settingsPage = await projectPage.projectTabs.goToSettings();
  const successPanel = await (
    await settingsPage.openInviteDialog()
  ).createRestrictedInvite({
    email: inviteeEmail,
    role: "write",
  });
  const inviteUrl = await successPanel.getInviteUrl();
  expect(inviteUrl).toContain("/invite/");

  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  const invitePage = await goToPage(inviteePage, InvitePage, inviteUrl);
  const inviteLoginPage = await invitePage.clickSignInToAccept();
  const returnedInvitePage =
    await inviteLoginPage.signInAsDevUserAndReturnToInvite(inviteeEmail);
  await returnedInvitePage.expectAcceptVisible();
  await returnedInvitePage.accept();
  const acceptedInvitePage = await goToPage(inviteePage, InvitePage, inviteUrl);
  await acceptedInvitePage.expectAlreadyAccepted();

  await inviteeContext.close();
});
