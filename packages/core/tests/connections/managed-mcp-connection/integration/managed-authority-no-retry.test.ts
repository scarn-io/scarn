/**
 * Server-owned no-retry (decisions 5, 13, 16): a run that lost managed
 * authority, whose managed connection wasn't ready, or that was abandoned
 * with a relayed call's outcome unknown is never retried, even under a
 * `Scarn.All` retry policy; an unrelated failure of the same step still is,
 * and a pipeline `catch` still routes the failure.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { createManagedOperation } from "@/connections/managed-mcp-connection/domain/managed-launch-connection-entity";
import { managedConnectionNotReadyError } from "@/connections/managed-mcp-connection/domain/managed-connection-not-ready";
import { getDb } from "@/lib/db";
import { createPipelineFromDocument } from "tests/pipeline-definitions/pipeline-test-support";
import { unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import {
  authorityLost,
  createSealTestClient,
  type SealProject,
} from "./managed-authority-seal-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const RETRY_ALL = { retry: [{ on: ["Scarn.All"], maxAttempts: 2 }] };
const notionRef = { notion: { type: "ref", auth: { connection: "notion" } } };
const LEASE_MS = 60_000;

describe("managed failures skip automatic retry", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, appContext, apiClient } = harness;
  const seal = createSealTestClient(harness);

  afterEach(() => {
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const retryAllProject = (label: string) =>
    seal.project(label, notionRef, RETRY_ALL);

  const runsOfTaskRun = async (target: SealProject, taskRunId: UuidV7) => {
    const run = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).get({
        headers: target.owner.authHeaders,
      }),
    );
    const runs = await unwrapAsync(
      apiClient.api
        .tasks({ taskId: run.taskId })
        .runs.get({ headers: target.owner.authHeaders }),
    );
    return runs
      .map((each) => ({ number: each.number, status: each.status }))
      .sort((left, right) => left.number - right.number);
  };

  /** A standalone Task of the project's step, claimed but not launched. */
  const claimRun = async (target: SealProject) => {
    const workItemId = await seal.seedNativeWorkItem(target.projectId);
    await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId: target.projectId,
          workItemId,
          stepDefinitionId: target.stepId,
          stepDefinitionVersion: 1,
          inputJson: {},
          executionTimeoutSeconds: 600,
        },
        { headers: target.owner.authHeaders },
      ),
    );
    return { ...(await seal.claim(target, workItemId)), workItemId };
  };

  const fail = (
    target: SealProject,
    run: { taskRunId: UuidV7; claimToken: string },
    errorJson: { name: string; message: string },
  ) =>
    unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).completions.post(
        {
          claimToken: run.claimToken,
          status: "failed",
          resultJson: null,
          errorJson,
        },
        { headers: target.owner.authHeaders },
      ),
    );

  /** Polls for work on `workItemId`, which fails the runs whose lease lapsed. */
  const poll = (target: SealProject, workItemId: UuidV7) =>
    unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId: target.projectId,
          workItemId,
          workerId: "no-retry-poller",
          batchSize: 1,
          leaseDurationSeconds: 60,
        },
        { headers: target.owner.authHeaders },
      ),
    );

  test("a Scarn.All policy doesn't retry a run that lost authority", async () => {
    const target = await retryAllProject("no-retry-lost");
    const run = await seal.launchRun(target);
    await seal.disconnect(target);

    const completed = await unwrapAsync(seal.complete(target, run));

    expect(completed).toMatchObject({
      status: "failed",
      errorJson: authorityLost("disconnected"),
    });
    expect((completed.errorJson as { message: string }).message).toMatch(
      /scarn tasks retry.*Notion changes the failed attempt already made may remain/s,
    );
    expect(await runsOfTaskRun(target, run.taskRunId)).toEqual([
      { number: 1, status: "failed" },
    ]);
  });

  test("a Scarn.All policy doesn't retry a not-ready launch", async () => {
    const target = await retryAllProject("no-retry-not-ready");
    const run = await claimRun(target);

    await fail(target, run, {
      name: "ManagedConnectionNotReady",
      message: managedConnectionNotReadyError(["Notion"]).message,
    });

    expect(await runsOfTaskRun(target, run.taskRunId)).toEqual([
      { number: 1, status: "failed" },
    ]);
  });

  test("an unrelated failure of the same step still retries", async () => {
    const target = await retryAllProject("no-retry-unrelated");
    const run = await seal.launchRun(target);

    await fail(target, run, { name: "Scarn.StepFailed", message: "Broke" });

    expect(await runsOfTaskRun(target, run.taskRunId)).toEqual([
      { number: 1, status: "failed" },
      { number: 2, status: "queued" },
    ]);
  });

  test("a Scarn.All policy doesn't retry a run abandoned with an unknown operation", async () => {
    const target = await retryAllProject("no-retry-abandoned-operation");
    const run = await seal.launchRun(target);
    const now = clock.now();
    await appContext.managedLaunchRepo.insertOperation(
      createManagedOperation({
        launchConnectionId: run.launchConnectionId,
        startedAt: now,
        deadlineAt: new Date(now.getTime() + 30_000),
      }),
      getDb(),
    );
    clock.advance(LEASE_MS + 1_000);

    expect(await poll(target, run.workItemId)).toEqual([]);

    expect(await runsOfTaskRun(target, run.taskRunId)).toEqual([
      { number: 1, status: "abandoned" },
    ]);
  });

  test("a run abandoned with no operation still retries", async () => {
    const target = await retryAllProject("no-retry-abandoned-clean");
    const run = await seal.launchRun(target);
    clock.advance(LEASE_MS + 1_000);

    await poll(target, run.workItemId);

    expect(await runsOfTaskRun(target, run.taskRunId)).toMatchObject([
      { number: 1, status: "abandoned" },
      { number: 2 },
    ]);
  });

  test("a pipeline step under Scarn.All retry routes ManagedConnectionAuthorityLost through its catch", async () => {
    const target = await seal.project("no-retry-pipeline");
    const definition = await createPipelineFromDocument(
      apiClient,
      target.owner.authHeaders,
      target.projectId,
      {
        schemaVersion: 1,
        key: `no-retry-pipeline-${crypto.randomUUID()}`,
        start: { to: "notion" },
        nodes: {
          notion: {
            kind: "step",
            step: target.stepKey,
            retry: [{ on: ["Scarn.All"], maxAttempts: 2 }],
            catch: [{ on: ["ManagedConnectionAuthorityLost"], to: "lost" }],
            next: { routes: [{ to: "done" }] },
          },
          done: { kind: "succeed" },
          lost: { kind: "fail", error: "NotionLost" },
        },
      },
    );
    const workItemId = await seal.seedNativeWorkItem(target.projectId);
    const execution = await unwrapAsync(
      apiClient.api["pipeline-executions"].post(
        {
          projectId: target.projectId,
          workItemId,
          pipelineDefinitionId: parseUuidV7(definition.id),
        },
        { headers: target.owner.authHeaders },
      ),
    );
    const claimed = await seal.claim(target, workItemId);
    await seal.register(target, claimed.taskRunId, claimed.claimToken);
    await seal.disconnect(target);

    await unwrapAsync(seal.complete(target, { ...claimed, workItemId }));

    expect(await runsOfTaskRun(target, claimed.taskRunId)).toEqual([
      { number: 1, status: "failed" },
    ]);
    expect(
      await unwrapAsync(
        apiClient.api["pipeline-executions"]({
          pipelineExecutionId: execution.id,
        }).get({ headers: target.owner.authHeaders }),
      ),
    ).toMatchObject({
      runStatus: "failed",
      endNodeId: "lost",
      error: { name: "NotionLost" },
    });
  });
});
