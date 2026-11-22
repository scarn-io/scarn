import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);

export const MONOREPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");

/** Scarn app origin (Next.js serves the API under /api). */
export const BASE_URL =
  process.env["SCARN_BASE_URL"] ?? "http://localhost:3000";

export const PROJECT_NAME = "acme-sandbox";

/** Holds the bare repo (`acme-shop.git`) and its working checkout (`acme-shop`). */
export const ROOT_DIR =
  process.env["SCARN_LOCAL_DEV_DIR"] ??
  path.join(homedir(), ".scarn-local-dev");

export const TEMPLATE_REPO_URL =
  process.env["SCARN_LOCAL_DEV_TEMPLATE_REPO"] ??
  "https://github.com/scarn-io/demo-shop-template.git";

export const TEMPLATE_REF =
  process.env["SCARN_LOCAL_DEV_TEMPLATE_REF"] ?? "main";

/**
 * Project secrets seed saves. `LOCAL_DEV_API_KEY` is a placeholder, not a real
 * credential; the `local-secrets` environment maps it into `ld-secrets`.
 */
export const PROJECT_SECRETS = [
  {
    name: "LOCAL_DEV_API_KEY",
    value:
      process.env["SCARN_LOCAL_DEV_API_KEY"] ?? "ld-sandbox-not-a-real-key-7f3a",
  },
];

/** Dev-login identity, only used when there is no saved profile for `BASE_URL`. */
export const DEV_LOGIN_EMAIL =
  process.env["SCARN_LOCAL_DEV_EMAIL"] ?? "local-dev@scarn.local";
