import { normalizeScarnApiOrigin } from "./scarn-api-url";
import { createScarnTreaty } from "./scarn-treaty";

export const resolveBrowserScarnApiBaseUrl = ({
  envApiUrl,
  browserOrigin,
}: {
  envApiUrl?: string | null | undefined;
  browserOrigin?: string | null | undefined;
}): string =>
  normalizeScarnApiOrigin(envApiUrl) ??
  normalizeScarnApiOrigin(browserOrigin) ??
  "";

export const getBrowserScarnApiClient = () =>
  createScarnTreaty(
    resolveBrowserScarnApiBaseUrl({
      envApiUrl: process.env.NEXT_PUBLIC_SCARN_API_URL,
      browserOrigin:
        typeof window === "undefined" ? undefined : window.location.origin,
    }),
  );
