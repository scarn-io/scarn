import { describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { usageMeters } from "@/lib/db/schema";
import { PLAN_LIMITS_CONFIG } from "@/billing/plan/domain/plan-limits";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const PERIOD = "2026-07";
const SIGNAL_CAP = PLAN_LIMITS_CONFIG.free.maxSignalTokensPerMonth;

/**
 * `POST /api/projects/:projectId/work-signal-token` against real Postgres:
 * each issued token is one push session on the org's monthly meter, and the
 * meter row lock keeps concurrent issues from overshooting the cap.
 */
describe("work signal token post endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(NOW),
      workSignalConnection: {
        url: "https://signal.example.com",
        tokenSecret: "work-signal-secret",
      },
    }),
  );
  const apiClient = createScarnTreaty(app);

  const setUpProject = async (signalTokens: number | null) => {
    const owner = await createTestUserAndSession({
      email: `work-signal-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Signal Project",
          description: "Project for work signal token tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: owner.authHeaders },
      ),
    );
    const orgId = parseUuidV7(project.orgId);
    if (signalTokens !== null) {
      await getDb().insert(usageMeters).values({
        orgId,
        period: PERIOD,
        planId: "free",
        signalTokens,
      });
    }
    const issue = () =>
      apiClient.api
        .projects({ projectId: project.id })
        ["work-signal-token"].post(
          { workerId: "worker-a" },
          { headers: owner.authHeaders },
        );
    return { orgId, issue };
  };

  const signalTokensFor = async (orgId: UuidV7) => {
    const [row] = await getDb()
      .select({ signalTokens: usageMeters.signalTokens })
      .from(usageMeters)
      .where(and(eq(usageMeters.orgId, orgId), eq(usageMeters.period, PERIOD)));
    return row?.signalTokens ?? null;
  };

  concurrentTest("records one push session per issued token", async () => {
    const { orgId, issue } = await setUpProject(null);

    await unwrapAsync(issue());
    await unwrapAsync(issue());

    expect(await signalTokensFor(orgId)).toBe(2);
  });

  concurrentTest(
    "returns 402 USAGE_LIMIT_EXCEEDED_SIGNAL at the cap without recording",
    async () => {
      const { orgId, issue } = await setUpProject(SIGNAL_CAP);

      const { data, error } = await issue();

      expect(data).toBeNull();
      expect(error?.status).toBe(402);
      expect(error?.value).toMatchObject({
        status: 402,
        code: "USAGE_LIMIT_EXCEEDED_SIGNAL",
      });
      expect(await signalTokensFor(orgId)).toBe(SIGNAL_CAP);
    },
  );

  concurrentTest(
    "issues exactly one token when two requests race at one below the cap",
    async () => {
      const { orgId, issue } = await setUpProject(SIGNAL_CAP - 1);

      const results = await Promise.all([issue(), issue()]);

      expect(
        results.map((result) => result.error?.status ?? 200).sort(),
      ).toEqual([200, 402]);
      expect(results.filter((result) => result.data?.token)).toHaveLength(1);
      expect(await signalTokensFor(orgId)).toBe(SIGNAL_CAP);
    },
  );
});
