import type { Page } from "@playwright/test";

type PageModelClass<T> = {
  fromPage(page: Page): Promise<T>;
};

export const goToPage = async <T>(
  page: Page,
  model: PageModelClass<T>,
  url: string,
): Promise<T> => {
  await page.goto(url);
  return model.fromPage(page);
};
