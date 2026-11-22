/**
 * The heartbeat's fast path of the authority fence (decision 3): a run's
 * heartbeat reports whether the managed connections its launch pinned still
 * authorize it, so the worker aborts an idle run promptly; the seal fence
 * still decides the stored failure.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import {
  authorityLost,
  createSealTestClient,
  type SealProject,
} from "./managed-authority-seal-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

describe("managed authority at the heartbeat", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, appContext, apiClient } = harness;
  const seal = createSealTestClient(harness);

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const heartbeat = async (
    target: SealProject,
    run: { taskRunId: UuidV7; claimToken: string },
  ) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).heartbeat.put(
        { claimToken: run.claimToken, leaseDurationSeconds: 60 },
        { headers: target.owner.authHeaders },
      ),
    );

  test("an idle run's heartbeat reports ok while its connection authorizes it", async () => {
    const target = await seal.project("heartbeat-ok");
    const run = await seal.launchRun(target);

    const beat = await heartbeat(target, run);

    expect(beat).toMatchObject({ status: "running", managedAuthority: "ok" });
  });

  test("a disconnect during an idle run: the next heartbeat reports the loss, and the worker's failure shows it on the Task", async () => {
    const target = await seal.project("heartbeat-disconnect");
    const run = await seal.launchRun(target);
    await seal.disconnect(target);

    const beat = await heartbeat(target, run);

    expect(beat).toMatchObject({
      status: "running",
      managedAuthority: { lost: "disconnected" },
    });
    expect(await seal.authorityLostEvents(target.connectionId)).toEqual([]);

    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).completions.post(
        {
          claimToken: run.claimToken,
          status: "failed",
          resultJson: { status: "failed" },
          errorJson: {
            name: "ManagedConnectionAuthorityLost",
            code: "MANAGED_CONNECTION_AUTHORITY_LOST",
            message: "Stopped by the worker.",
            cause: { reason: "disconnected" },
          },
        },
        { headers: target.owner.authHeaders },
      ),
    );

    const stored = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).get({
        headers: target.owner.authHeaders,
      }),
    );
    expect(stored).toMatchObject({
      status: "failed",
      errorJson: authorityLost("disconnected"),
    });
    expect(await seal.authorityLostEvents(target.connectionId)).toEqual([
      {
        type: "authority_lost",
        taskRunId: run.taskRunId,
        reasonCode: "disconnected",
      },
    ]);
  });

  test("a run without managed launches reports ok and reads no connection or grant", async () => {
    const target = await seal.project("heartbeat-no-launch");
    const step = await seal.createStep(target.owner, target.projectId, {});
    const workItemId = await seal.seedNativeWorkItem(target.projectId);
    await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId: target.projectId,
          workItemId,
          stepDefinitionId: step.id,
          stepDefinitionVersion: 1,
          inputJson: {},
          executionTimeoutSeconds: 600,
        },
        { headers: target.owner.authHeaders },
      ),
    );
    const run = await seal.claim(target, workItemId);
    const listOpenForRun = spyOn(appContext.managedLaunchRepo, "listOpenForRun");
    const loadForShare = spyOn(appContext.managedConnectionRepo, "loadForShare");
    const findById = spyOn(appContext.managedOAuthGrantRepo, "findById");

    try {
      const beat = await heartbeat(target, run);

      expect(beat).toMatchObject({ status: "running", managedAuthority: "ok" });
      expect(listOpenForRun).toHaveBeenCalledTimes(1);
      expect(loadForShare).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
    } finally {
      listOpenForRun.mockRestore();
      loadForShare.mockRestore();
      findById.mockRestore();
    }
  });
});
