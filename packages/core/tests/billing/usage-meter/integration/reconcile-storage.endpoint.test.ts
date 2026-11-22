import { createAppContext } from "@/lib/di";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { DbExecutor } from "@/lib/db/db-executor";
import type { PlanId } from "@/billing/plan/contracts/plan-contracts";
import { DrizzleStorageUsageReader } from "@/billing/usage-meter/infra/drizzle-storage-usage-reader";
import { DrizzleUsageMeterRepo } from "@/billing/usage-meter/infra/drizzle-usage-meter-repo";
import { DrizzleArtifactFailureRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-failure-repo";
import { DrizzleArtifactRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-repo";
import { DrizzleTaskRunRepo } from "@/tasks/task-run/infra/drizzle-task-run-repo";
import { createApp } from "@scarn/api/app";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fixedTimeProvider } from "tests/utils";

/**
 * Integration coverage for the scheduled maintenance endpoint
 * `POST /api/internal/usage/reconcile-storage`: its service-token auth
 * boundary and that it runs the reconciliation for every org.
 *
 * The real job sweeps the whole shared test database (it clears every org's
 * expired sessions, artifacts and archives, and overwrites every meter in the
 * period), which breaks other files running alongside under
 * `bun test --parallel`. So the reconcile steps here are stubbed to record
 * their calls; the job's effect on real rows is covered, scoped to one org, in
 * `tests/billing/usage-meter/reconcile-storage-usage.test.ts`.
 */
type Call = { step: string; orgId: UuidV7 | undefined };

const recordingReconcileDeps = () => {
  const calls: Call[] = [];
  const retainedOrgId = createUuidV7();

  class RecordingTaskRunRepo extends DrizzleTaskRunRepo {
    override clearExpiredLogArchives(
      _now: Date,
      _retentionDays: number,
      _dbExecutor?: DbExecutor,
      orgId?: UuidV7,
    ) {
      calls.push({ step: "logArchives", orgId });
      return Promise.resolve(0);
    }
    override clearExpiredSessions(
      _now: Date,
      _retentionDays: number,
      _dbExecutor?: DbExecutor,
      orgId?: UuidV7,
    ) {
      calls.push({ step: "sessions", orgId });
      return Promise.resolve(0);
    }
  }

  class RecordingArtifactRepo extends DrizzleArtifactRepo {
    override clearExpiredArtifacts(
      _now: Date,
      _retentionDays: number,
      _dbExecutor?: DbExecutor,
      orgId?: UuidV7,
    ) {
      calls.push({ step: "artifacts", orgId });
      return Promise.resolve(0);
    }
  }

  class RecordingArtifactFailureRepo extends DrizzleArtifactFailureRepo {
    override deleteExpiredFailures(
      _now: Date,
      _retentionDays: number,
      _dbExecutor?: DbExecutor,
      orgId?: UuidV7,
    ) {
      calls.push({ step: "failures", orgId });
      return Promise.resolve(0);
    }
  }

  class RecordingStorageUsageReader extends DrizzleStorageUsageReader {
    override sumRetainedBytesByOrg(
      _now: Date,
      _retentionDays: number,
      _dbExecutor?: DbExecutor,
      orgId?: UuidV7,
    ) {
      calls.push({ step: "sum", orgId });
      return Promise.resolve([{ orgId: retainedOrgId, bytes: 512 }]);
    }
  }

  const reconciled: { period: string; orgIds: UuidV7[] }[] = [];
  class RecordingUsageMeterRepo extends DrizzleUsageMeterRepo {
    override reconcileStorageForPeriod(
      period: string,
      retainedByOrg: { orgId: UuidV7; bytes: number }[],
      _defaultPlanId: PlanId,
      _dbExecutor?: DbExecutor,
      orgId?: UuidV7,
    ) {
      calls.push({ step: "meters", orgId });
      reconciled.push({
        period,
        orgIds: retainedByOrg.map((row) => row.orgId),
      });
      return Promise.resolve(retainedByOrg.length);
    }
  }

  return {
    calls,
    reconciled,
    retainedOrgId,
    overrides: {
      taskRunRepo: new RecordingTaskRunRepo(),
      artifactRepo: new RecordingArtifactRepo(),
      artifactFailureRepo: new RecordingArtifactFailureRepo(),
      storageUsageReader: new RecordingStorageUsageReader(),
      usageMeterRepo: new RecordingUsageMeterRepo(),
    },
  };
};

describe("reconcile-storage endpoint", () => {
  const SECRET = "test-reconcile-secret-abcdef0123456789";
  const NOW = new Date("2026-08-15T00:00:00.000Z");
  const deps = recordingReconcileDeps();
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(NOW),
      ...deps.overrides,
    }),
  );

  const post = (headers?: HeadersInit) =>
    app.handle(
      new Request("http://localhost/api/internal/usage/reconcile-storage", {
        method: "POST",
        headers,
      }),
    );

  let original: string | undefined;
  beforeEach(() => {
    original = process.env["RECONCILE_CRON_SECRET"];
    process.env["RECONCILE_CRON_SECRET"] = SECRET;
    deps.calls.length = 0;
    deps.reconciled.length = 0;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env["RECONCILE_CRON_SECRET"];
    } else {
      process.env["RECONCILE_CRON_SECRET"] = original;
    }
  });

  test("returns 401 without a service token, and reconciles nothing", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(deps.calls).toEqual([]);
  });

  test("returns 401 with a wrong service token, and reconciles nothing", async () => {
    const res = await post({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(deps.calls).toEqual([]);
  });

  test("with the correct token, reconciles every org for the current period and returns the count", async () => {
    const res = await post({ authorization: `Bearer ${SECRET}` });

    expect(res.status).toBe(200);
    expect((await res.json()) as { orgsReconciled: number }).toEqual({
      orgsReconciled: 1,
    });
    expect(deps.calls).toEqual([
      { step: "logArchives", orgId: undefined },
      { step: "sessions", orgId: undefined },
      { step: "artifacts", orgId: undefined },
      { step: "failures", orgId: undefined },
      { step: "sum", orgId: undefined },
      { step: "meters", orgId: undefined },
    ]);
    expect(deps.reconciled).toEqual([
      { period: "2026-08", orgIds: [deps.retainedOrgId] },
    ]);
  });
});
