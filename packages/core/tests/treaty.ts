import { treaty } from "@elysia/eden";
import type { App } from "@scarn/api/app";

const TRAILING_SLASHES_PATTERN = /\/+$/u;
const API_SUFFIX_PATTERN = /\/api$/u;

const normalizeScarnBaseUrl = (baseUrl: string): string => {
  const trimmedBaseUrl = baseUrl.trim();
  if (trimmedBaseUrl.length === 0) {
    return "";
  }

  return trimmedBaseUrl
    .replace(TRAILING_SLASHES_PATTERN, "")
    .replace(API_SUFFIX_PATTERN, "");
};

export function createScarnTreaty(
  baseUrlOrApp: string | App,
): ReturnType<typeof treaty<App>> {
  if (typeof baseUrlOrApp === "string") {
    return treaty<App>(normalizeScarnBaseUrl(baseUrlOrApp), {
      parseDate: false,
    });
  }

  return treaty(baseUrlOrApp, {
    parseDate: false,
  });
}

export const createScarnApiClient = createScarnTreaty;
