import { expect, type Page } from "@playwright/test";
import { assertPageUrl } from "./page-url";

export class CliAuthPage {
  constructor(readonly page: Page) {}

  static path(userCode: string): string {
    return `/cli-auth?user_code=${encodeURIComponent(userCode)}`;
  }

  static async fromPage(page: Page): Promise<CliAuthPage> {
    await assertPageUrl(page, (url) => url.pathname === "/cli-auth");
    return new CliAuthPage(page);
  }

  async expectUserCode(userCode: string): Promise<CliAuthPage> {
    await expect(this.page.getByLabel("CLI code")).toHaveValue(userCode);
    return this;
  }
}
