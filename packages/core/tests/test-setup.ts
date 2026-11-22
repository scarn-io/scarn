import { config as loadDotenv } from "dotenv";
import { TEST_BETTER_AUTH_SECRET } from "@scarn/identity/testing/access-jwt-signing-keys";
import { getTestDatabaseUrl } from "@scarn/local-dev/test-db";

// Run setup during preload evaluation so Bun aborts the run if initialization fails.
loadDotenv({ path: ".env", override: false });

process.env["IS_TESTING"] ??= "1";
// Fixed dev/test key. Never use it in production.
process.env["SECRETS_ENCRYPTION_KEY"] ??=
  "Ym9ib2RkeS1kZXYtc2VjcmV0cy1rZXktbm90LXByb2Q=";
process.env["BETTER_AUTH_SECRET"] ??= TEST_BETTER_AUTH_SECRET;
process.env["BETTER_AUTH_URL"] ??= "http://localhost";
process.env["BETTER_AUTH_TRUSTED_ORIGINS"] ??= "http://localhost";
process.env["APP_URL"] ??= "http://localhost:1111";
process.env["SCARN_DEFAULT_PLAN"] ??= "free";

process.env["DATABASE_URL"] = await getTestDatabaseUrl();
