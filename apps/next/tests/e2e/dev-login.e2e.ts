import { expect, test } from "@playwright/test";
import { LoginPage } from "./models/pages/login-page";
import { goToPage } from "./support/go-to-page";

test("signs in with dev login", async ({ page }) => {
  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  await loginPage.signInAsDevUser("e2e-user@scarn.local");
  await expect(page).not.toHaveURL(/\/login/);
});
