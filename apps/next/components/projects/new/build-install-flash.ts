export type InstallFlash = {
  severity: "success" | "error";
  text: string;
};

// Mirrors the settings page's `ERROR_MESSAGES` (Phase 2's install-state error
// reasons), scoped to what `/projects/new` can actually receive back from
// `GET /integrations/github/callback` under `intent: "create"`.
const ERROR_MESSAGES: Record<string, string> = {
  missing_params:
    "GitHub redirected back without the expected parameters. Try again.",
  malformed: "The install link was malformed. Try again.",
  signature_mismatch:
    "The install state could not be verified. Try connecting GitHub again.",
  expired: "The install link expired before you finished. Try again.",
  invalid_payload: "The install state was invalid. Try again.",
  invalid_state: "The install state was invalid. Try again.",
  github_app_not_configured:
    "GitHub App is not configured on this server. Ask an admin to set GITHUB_APP_* env vars.",
};

/** Reads `?installation=connected` / `?error=...` off `/projects/new`'s URL. */
export function buildInstallFlash(
  searchParams: URLSearchParams,
): InstallFlash | null {
  const installation = searchParams.get("installation");
  if (installation === "connected") {
    return { severity: "success", text: "GitHub account connected." };
  }

  const error = searchParams.get("error");
  if (error) {
    return {
      severity: "error",
      text: ERROR_MESSAGES[error] ?? `Could not connect GitHub: ${error}`,
    };
  }

  return null;
}
