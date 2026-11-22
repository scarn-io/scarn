/**
 * The authority fence at a run's seal (decisions 3, 4, 9, 15, 16; proof P9):
 * authority that moved before the completion or yield commits fails the run
 * with `ManagedConnectionAuthorityLost` and applies none of its changes; a
 * relayed call in flight or a pending refresh holds the seal back with a
 * 409; a seal that committed first is final.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { acquireManagedAccessToken } from "@/connections/managed-mcp-connection/application/acquire-managed-access-token";
import type { ManagedOAuthProvider } from "@/connections/managed-mcp-connection/application/oauth-provider";
import { createManagedOperation } from "@/connections/managed-mcp-connection/domain/managed-launch-connection-entity";
import { MANAGED_REFRESH_STALE_MS } from "@/connections/managed-mcp-connection/domain/managed-oauth-grant-entity";
import { getDb } from "@/lib/db";
import { unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import {
  authorityLost,
  createSealTestClient,
  type SealProject,
  type SealRun,
} from "./managed-authority-seal-test-support";
import {
  createManagedConnectionHarness,
  overrideManagedOAuthProviders,
} from "./managed-connection-test-support";

const HOUR_MS = 60 * 60 * 1000;

const failureOf = async (promise: Promise<object>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
};

describe("managed authority fence at the seal", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, appContext } = harness;
  const seal = createSealTestClient(harness);

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const runOf = async (target: SealProject, run: SealRun) =>
    await unwrapAsync(
      harness.apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).get({
        headers: target.owner.authHeaders,
      }),
    );

  const expectFailedUnapplied = async (
    target: SealProject,
    run: SealRun,
    reason: string,
  ) => {
    const stored = await runOf(target, run);
    expect(stored).toMatchObject({
      status: "failed",
      errorJson: authorityLost(reason),
      resultJson: null,
    });
    expect(await seal.commentsOn(run.workItemId)).toEqual([]);
    expect(
      await appContext.managedLaunchRepo.listOpenForRun(run.taskRunId, getDb()),
    ).toEqual([]);
  };

  const connectionInput = (target: SealProject) => ({
    projectId: target.projectId,
    connectionId: target.connectionId,
  });

  test("a disconnect that commits first fails the completion and applies nothing", async () => {
    const target = await seal.project("seal-disconnect-first");
    const run = await seal.launchRun(target);
    await seal.disconnect(target);

    const completed = await unwrapAsync(seal.complete(target, run));

    expect(completed.status).toBe("failed");
    await expectFailedUnapplied(target, run, "disconnected");
    expect(await seal.authorityLostEvents(target.connectionId)).toEqual([
      {
        type: "authority_lost",
        taskRunId: run.taskRunId,
        reasonCode: "disconnected",
      },
    ]);
  });

  test("a completion that commits first stays succeeded after a disconnect", async () => {
    const target = await seal.project("seal-complete-first");
    const run = await seal.launchRun(target);

    const completed = await unwrapAsync(seal.complete(target, run));
    await seal.disconnect(target);

    expect(completed.status).toBe("succeeded");
    expect((await runOf(target, run)).status).toBe("succeeded");
    expect(await seal.commentsOn(run.workItemId)).toEqual([
      { body: "From the run" },
    ]);
    expect(await seal.authorityLostEvents(target.connectionId)).toEqual([]);
  });

  test("a yield after a disconnect fails the run instead of handing over", async () => {
    const target = await seal.project("seal-yield-disconnect");
    const run = await seal.launchRun(target);
    await seal.disconnect(target);

    const yielded = await unwrapAsync(seal.yieldRun(target, run));

    expect(yielded.status).toBe("failed");
    await expectFailedUnapplied(target, run, "disconnected");
  });

  test("a bystander can't seal while a refresh is pending, and seals once it commits", async () => {
    const target = await seal.project("seal-refresh-pending");
    clock.advance(HOUR_MS);
    const bystander = await seal.launchRun(target);
    const gate = Promise.withResolvers<undefined>();
    const claimed = Promise.withResolvers<undefined>();
    const gated = overrideManagedOAuthProviders(
      appContext.managedOAuthProviders,
      {
        refresh: async (
          input: Parameters<ManagedOAuthProvider["refresh"]>[0],
        ) => {
          claimed.resolve(undefined);
          await gate.promise;
          return await harness.fakeProvider().refresh(input);
        },
      },
    );
    const refreshing = acquireManagedAccessToken(connectionInput(target), {
      ...appContext,
      managedOAuthProviders: gated,
    });
    await claimed.promise;

    const blocked = await seal.complete(target, bystander);
    expect(blocked.error?.status).toBe(409);
    expect(blocked.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_REFRESH_PENDING",
    });
    expect((await runOf(target, bystander)).status).toBe("running");
    expect(await seal.commentsOn(bystander.workItemId)).toEqual([]);

    gate.resolve(undefined);
    await refreshing;
    const sealed = await unwrapAsync(seal.complete(target, bystander));

    expect(sealed.status).toBe("succeeded");
    expect(await seal.commentsOn(bystander.workItemId)).toEqual([
      { body: "From the run" },
    ]);
  });

  test("a stale claim blocks until it is recovered to reconnect_required, which fails the bystander", async () => {
    const target = await seal.project("seal-refresh-stale");
    clock.advance(HOUR_MS);
    const bystander = await seal.launchRun(target);
    const crashing = overrideManagedOAuthProviders(
      appContext.managedOAuthProviders,
      { refresh: () => Promise.reject(new Error("crashed before send")) },
    );
    expect(
      await failureOf(
        acquireManagedAccessToken(connectionInput(target), {
          ...appContext,
          managedOAuthProviders: crashing,
        }),
      ),
    ).toMatchObject({ message: "crashed before send" });
    clock.advance(MANAGED_REFRESH_STALE_MS + 1_000);

    const blocked = await seal.complete(target, bystander);
    expect(blocked.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_REFRESH_PENDING",
    });

    expect(
      await failureOf(
        acquireManagedAccessToken(connectionInput(target), appContext),
      ),
    ).toMatchObject({ code: "MANAGED_CONNECTION_NOT_READY" });
    const completed = await unwrapAsync(seal.complete(target, bystander));

    expect(completed.status).toBe("failed");
    await expectFailedUnapplied(target, bystander, "reconnect_required");
  });

  test("a confirmed reconnect fails the old run; a new launch pins the new generation", async () => {
    const target = await seal.project("seal-reconnect");
    const old = await seal.launchRun(target);
    const before = await harness.getConnection(
      target.owner,
      target.projectId,
      target.connectionId,
    );
    const { pending, candidate } = await harness.reconnectToCandidate(
      target.owner,
      target.projectId,
      target.connectionId,
    );
    await unwrapAsync(
      harness
        .connections(target.projectId)({ connectionId: target.connectionId })
        .candidate.confirm.post(
          {
            candidateId: candidate.id,
            fingerprint: candidate.fingerprint,
            expectedVersion: pending.version,
          },
          { headers: { ...target.owner.authHeaders, origin: harness.origin } },
        ),
    );

    const failed = await unwrapAsync(seal.complete(target, old));
    expect(failed.status).toBe("failed");
    await expectFailedUnapplied(target, old, "replaced");

    const fresh = await seal.launchRun(target);
    const [launch] = await appContext.managedLaunchRepo.listOpenForRun(
      fresh.taskRunId,
      getDb(),
    );
    expect(launch).toMatchObject({
      generation: before.generation + 1,
      grantId: candidate.id,
    });
    expect((await unwrapAsync(seal.complete(target, fresh))).status).toBe(
      "succeeded",
    );
  });

  test("an operation in flight refuses the seal with 409; it seals once the operation ends", async () => {
    const target = await seal.project("seal-in-flight");
    const run = await seal.launchRun(target);
    const now = clock.now();
    const operation = createManagedOperation({
      launchConnectionId: run.launchConnectionId,
      startedAt: now,
      deadlineAt: new Date(now.getTime() + 60_000),
    });
    expect(
      await appContext.managedLaunchRepo.insertOperation(operation, getDb()),
    ).toBe(true);

    const blocked = await seal.complete(target, run);
    expect(blocked.error?.status).toBe(409);
    expect(blocked.error?.value).toMatchObject({
      code: "MANAGED_OPERATION_IN_FLIGHT",
    });
    const blockedYield = await seal.yieldRun(target, run);
    expect(blockedYield.error?.value).toMatchObject({
      code: "MANAGED_OPERATION_IN_FLIGHT",
    });
    expect((await runOf(target, run)).status).toBe("running");

    await appContext.managedLaunchRepo.deleteOperation(operation.id);
    const sealed = await unwrapAsync(seal.complete(target, run));

    expect(sealed.status).toBe("succeeded");
    expect(await seal.commentsOn(run.workItemId)).toEqual([
      { body: "From the run" },
    ]);
  });

  test("an operation past its deadline fails the run with operation_unknown", async () => {
    const target = await seal.project("seal-operation-unknown");
    const run = await seal.launchRun(target);
    const now = clock.now();
    await appContext.managedLaunchRepo.insertOperation(
      createManagedOperation({
        launchConnectionId: run.launchConnectionId,
        startedAt: now,
        deadlineAt: new Date(now.getTime() + 1_000),
      }),
      getDb(),
    );
    clock.advance(2_000);

    const completed = await unwrapAsync(seal.complete(target, run));

    expect(completed.status).toBe("failed");
    await expectFailedUnapplied(target, run, "operation_unknown");
    expect(await seal.authorityLostEvents(target.connectionId)).toMatchObject([
      { taskRunId: run.taskRunId, reasonCode: "operation_unknown" },
    ]);
  });

  test("a run that references no connection costs the fence one query", async () => {
    const target = await seal.project("seal-no-reference");
    const plain = await seal.createStep(target.owner, target.projectId, {});
    const workItemId = await seal.seedNativeWorkItem(target.projectId);
    await unwrapStartedTaskAsync(
      harness.apiClient.api.tasks.post(
        {
          projectId: target.projectId,
          workItemId,
          stepDefinitionId: plain.id,
          stepDefinitionVersion: 1,
          inputJson: {},
        },
        { headers: target.owner.authHeaders },
      ),
    );
    const claimed = await seal.claim(target, workItemId);
    const spies = {
      listOpenForRun: spyOn(appContext.managedLaunchRepo, "listOpenForRun"),
      lockOperationsForSeal: spyOn(
        appContext.managedLaunchRepo,
        "lockOperationsForSeal",
      ),
      loadForShare: spyOn(appContext.managedConnectionRepo, "loadForShare"),
      findById: spyOn(appContext.managedOAuthGrantRepo, "findById"),
      append: spyOn(appContext.managedConnectionEventRepo, "append"),
    };
    try {
      const completed = await unwrapAsync(
        seal.complete(target, { ...claimed, workItemId }),
      );

      expect(completed.status).toBe("succeeded");
      expect(spies.listOpenForRun).toHaveBeenCalledTimes(1);
      expect(spies.lockOperationsForSeal).not.toHaveBeenCalled();
      expect(spies.loadForShare).not.toHaveBeenCalled();
      expect(spies.findById).not.toHaveBeenCalled();
      expect(spies.append).not.toHaveBeenCalled();
    } finally {
      for (const spy of Object.values(spies)) {
        spy.mockRestore();
      }
    }
  });
});
