import { expect, test } from "@playwright/test";
import { usernameFromEmail } from "./models/pages/onboarding-username-page";

// Regression coverage for the `callbackUrl` chain across BOTH auth guards
// (`(protected)/layout.tsx` and its onboarding redirect): a brand-new visitor
// who clicks a link straight into a protected page while signed out should
// land back on that exact page once they've logged in *and* finished
// onboarding — not on the dashboard, which is what a bare `redirect("/login")`
// (with no `callbackUrl`) would otherwise produce.
test("returns a brand-new user to their original destination after login and onboarding", async ({
  page,
}) => {
  const destination = "/account/settings";
  const email = `e2e-redirect-${crypto.randomUUID()}@scarn.local`;

  // Simulates clicking a link straight into a protected page while signed out.
  await page.goto(destination);
  await expect(page).toHaveURL(
    `/login?callbackUrl=${encodeURIComponent(destination)}`,
  );

  // Dev login redirects to `callbackUrl` immediately on success, but this is a
  // brand-new user, so the protected layout's onboarding guard intercepts the
  // navigation next.
  await page
    .getByRole("form", { name: "Dev login" })
    .getByLabel("Email")
    .fill(email);
  await page.getByRole("button", { name: "Sign in as this user" }).click();
  await expect(page).toHaveURL(
    `/onboarding/username?callbackUrl=${encodeURIComponent(destination)}`,
  );

  await page.getByLabel("Username").fill(usernameFromEmail(email));
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(destination);
});
