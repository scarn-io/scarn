import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
  TestInfo,
} from "@playwright/test";
import { LoginPage } from "../models/pages/login-page";
import { goToPage } from "./go-to-page";

export const apiHarUrlFilter = /\/api(?:\/|$)/;

export const createLoggedInContext = async (
  browser: Browser,
  email: string,
  options?: {
    harFileName?: string;
    testInfo?: TestInfo;
    contextOptions?: BrowserContextOptions;
  },
): Promise<{
  context: BrowserContext;
  page: Page;
}> => {
  const harOptions =
    options?.harFileName && options.testInfo
      ? {
          recordHar: {
            path: options.testInfo.outputPath(options.harFileName),
            content: "attach" as const,
            mode: "full" as const,
            urlFilter: apiHarUrlFilter,
          },
        }
      : {};

  const context = await browser.newContext({
    ...harOptions,
    ...options?.contextOptions,
  });
  const page = await context.newPage();
  const loginPage = await goToPage(page, LoginPage, LoginPage.path());
  await loginPage.signInAsDevUser(email);

  return { context, page };
};
