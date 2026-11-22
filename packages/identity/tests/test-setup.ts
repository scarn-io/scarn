import { afterAll } from "bun:test";
import { getTestDatabaseUrl } from "@scarn/local-dev/test-db";
import { closeDb, resetDbForTests } from "@/lib/db";
import { TEST_BETTER_AUTH_SECRET } from "./integration/helpers/access-jwt-signing-keys";

process.env["BETTER_AUTH_SECRET"] ??= TEST_BETTER_AUTH_SECRET;
process.env["BETTER_AUTH_URL"] ??= "http://localhost";
process.env["BETTER_AUTH_TRUSTED_ORIGINS"] ??= "http://localhost";
process.env["IS_TESTING"] ??= "1";
process.env["DEVICE_AUTH_INTERVAL"] ??= "1s";

process.env["DATABASE_URL"] = await getTestDatabaseUrl();
await resetDbForTests();

afterAll(async () => {
  await closeDb();
});
