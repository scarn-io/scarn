import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";
import { v7 as uuidv7 } from "uuid";

/**
 * Integration coverage for `GET /api/orgs/:orgId/usage` (the Phase 7 read
 * surface backed by `getOrgUsage`).
 *
 * GAP (documented; see Phase 8 report): the integration auth helper
 * (`@scarn/identity/testing` `createTestUserAndSession`) seeds the user,
 * account, and session rows directly via Drizzle repos. It therefore does NOT
 * fire better-auth's `account.create.after` hook, which is the ONLY code path
 * that calls `ensurePersonalOrganization`. As a result, a test user owns NO
 * organization and there is no public API endpoint that creates/lists the
 * caller's org. The "authenticated member sees zeroed usage" happy path can
 * thus not be driven end-to-end through the public client here; it is covered
 * at the domain level by the `UsageMeter`/`getOrgUsage` unit + use-case tests,
 * and is best exercised end-to-end by the e2e suite (real OAuth signup that
 * provisions the personal org). See report follow-ups.
 *
 * What we CAN assert through the public boundary: the authn gate (401) and the
 * "org you don't belong to" gate. Because the test auth helper seeds a user
 * with no organization, any org id supplied here is one the caller is not a
 * member of — `getOrgUsage` loads it, finds no organization row, and returns
 * 404 BEFORE the membership check (which would otherwise be 403). We assert
 * that observed behavior.
 */
describe("usage get endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-06-28T12:00:00.000Z")),
    }),
  );

  concurrentTest("returns 401 when the request is unauthenticated", async () => {
    const apiClient = createScarnTreaty(app);

    const { data, error } = await apiClient.api
      .orgs({ orgId: uuidv7() })
      .usage.get();

    expect(data).toBeNull();
    expect(error?.status).toBe(401);
    expect(error?.value).toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  concurrentTest(
    "returns 404 for an org the authenticated user is not a member of",
    async () => {
      const apiClient = createScarnTreaty(app);
      const user = await createTestUserAndSession({
        email: `usage-outsider-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api
        .orgs({ orgId: uuidv7() })
        .usage.get({
          headers: user.authHeaders,
        });

      expect(data).toBeNull();
      // No organization row exists for this id, so the use case returns a
      // ResourceNotFoundError (404) before reaching the membership (403) gate.
      expect(error?.status).toBe(404);
    },
  );

  concurrentTest(
    "rejects a malformed org id with a validation error",
    async () => {
      const apiClient = createScarnTreaty(app);
      const user = await createTestUserAndSession({
        email: `usage-badid-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api
        .orgs({ orgId: "not-a-uuid" })
        .usage.get({
          headers: user.authHeaders,
        });

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
    },
  );
});
