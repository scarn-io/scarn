import { treaty } from "@elysia/eden";
import type { App } from "@scarn/api/app";
import { stripScarnApiSuffix } from "./scarn-api-url";

export function createScarnTreaty(
  baseUrlOrApp: string | App,
): ReturnType<typeof treaty<App>> {
  if (typeof baseUrlOrApp === "string") {
    return treaty<App>(stripScarnApiSuffix(baseUrlOrApp), {
      parseDate: false,
      fetch: { credentials: "include" },
    });
  }

  return treaty(baseUrlOrApp, {
    parseDate: false,
  });
}

type EdenResult<T> = {
  data: T | null | undefined;
  error: { value: unknown } | null | undefined;
};

export const unwrapTreatyResponse = async <T>(
  promise: Promise<EdenResult<T>>,
): Promise<T> => {
  const { data, error } = await promise;

  if (error) {
    throw error.value;
  }

  return data as T;
};

export const createScarnApiClient = createScarnTreaty;
