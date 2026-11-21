const DEFAULT_BASE_URL = "https://api.scarn.io";
const DEFAULT_APP_URL = "https://app.scarn.io";

const trimTrailingSlashes = (value: string) => {
  let endIndex = value.length;
  while (endIndex > 0 && value.charAt(endIndex - 1) === "/") {
    endIndex -= 1;
  }
  return value.slice(0, endIndex);
};

const firstConfigured = (...values: (string | null | undefined)[]) => {
  for (const value of values) {
    const trimmedValue = value?.trim();
    if (trimmedValue) return trimTrailingSlashes(trimmedValue);
  }
  return undefined;
};

/**
 * The Scarn API URL every client calls: explicit value, then `SCARN_BASE_URL`,
 * then `https://api.scarn.io`.
 */
export const resolveScarnBaseUrl = (value?: string | null) =>
  firstConfigured(value, process.env["SCARN_BASE_URL"]) ?? DEFAULT_BASE_URL;

/**
 * The Scarn web app URL used for browser links: explicit value, then
 * `SCARN_APP_URL`, then an explicitly configured API URL (a self-hosted or
 * local server serves both), then `https://app.scarn.io`.
 */
export const resolveScarnAppUrl = (
  input: { appUrl?: string | null; baseUrl?: string | null } = {},
) =>
  firstConfigured(
    input.appUrl,
    process.env["SCARN_APP_URL"],
    input.baseUrl,
    process.env["SCARN_BASE_URL"],
  ) ?? DEFAULT_APP_URL;
