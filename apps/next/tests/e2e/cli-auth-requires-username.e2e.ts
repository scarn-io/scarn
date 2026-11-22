import { expect, test } from "@playwright/test";
import { CliAuthPage } from "./models/pages/cli-auth-page";
import {
  OnboardingUsernamePage,
  usernameFromEmail,
} from "./models/pages/onboarding-username-page";

// `/cli-auth` sits outside the protected layout, so it has its own username
// guard: a brand-new user signing in from `scarn init`'s device login picks a
// username before approving, then lands back on `/cli-auth` with the code the
// terminal printed still filled in.
test("sends a new user through the username step and back to /cli-auth with the code preserved", async ({
  page,
}) => {
  const userCode = "ABCD1234";
  const cliAuthPath = CliAuthPage.path(userCode);
  const email = `e2e-cli-auth-${crypto.randomUUID()}@scarn.local`;

  await page.goto(cliAuthPath);
  await expect(page).toHaveURL(
    `/login?callbackUrl=${encodeURIComponent(cliAuthPath)}`,
  );

  await page
    .getByRole("form", { name: "Dev login" })
    .getByLabel("Email")
    .fill(email);
  await page.getByRole("button", { name: "Sign in as this user" }).click();
  await expect(page).toHaveURL(
    `/onboarding/username?callbackUrl=${encodeURIComponent(cliAuthPath)}`,
  );

  const onboarding = await OnboardingUsernamePage.fromPage(page);
  await onboarding.chooseUsername(usernameFromEmail(email));

  await expect(page).toHaveURL(cliAuthPath);
  const cliAuth = await CliAuthPage.fromPage(page);
  await cliAuth.expectUserCode(userCode);
});
