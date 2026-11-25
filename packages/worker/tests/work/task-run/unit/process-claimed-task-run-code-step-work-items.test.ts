/**
 * Coverage for a code step that uses only work-item features (ADR 0018) in
 * `startProcessClaimedTaskRun`: with a `project` grant and no `mcps`, the run
 * still opens a step bridge, the step's `/work-items/upsert` call reaches the
 * API through it with the run's claim token, the bridge token is masked and
 * the claim token never reaches the runner.
 *
 * Uses the real `openMcpBridgeSession` on loopback, a fake work-item API on
 * the worker client and a fake `runCodeStepCommand` standing in for the step
 * that calls the bridge over HTTP with the env it was given.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  STEP_BRIDGE_TOKEN_ENV,
  STEP_BRIDGE_URL_ENV,
  STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH,
} from "@scarn/sdk/contracts/step-bridge";
import { startProcessClaimedTaskRun } from "../../../../src/work/task-run/application/process-claimed-task-run";
import type { RunCodeStepCommand } from "../../../../src/work/task-run/application/execute-code-step";
import {
  openMcpBridgeSession,
  type OpenMcpBridgeSessionInput,
} from "../../../../src/runtime/mcp-bridge/infra";
import type { TaskRunWorkItemsApi } from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  projectId,
  requestedByUserId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";
import { buildCodeStepDeps } from "./helpers/code-step-deps";

const CLAIM_TOKEN = "claim-token-value";

const ITEM = {
  platform: "github",
  platformKey: "acme/repo#7",
  title: "Bug",
  description: "It breaks",
  sourceUpdatedAt: "2026-11-02T00:00:00.000Z",
};

describe("startProcessClaimedTaskRun code step with only work-item features", () => {
  let workspacePath: string | undefined;

  afterEach(async () => {
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function runStep(input: {
    grants: Parameters<typeof buildCodeStepDeps>[0]["grants"];
    runCodeStepCommand: RunCodeStepCommand;
  }) {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-code-step-work-items-"),
    );
    const workItems = {
      upsertTaskRunWorkItems: vi.fn<
        TaskRunWorkItemsApi["upsertTaskRunWorkItems"]
      >(() =>
        Promise.resolve({
          status: 200,
          body: {
            items: [
              {
                workItemId: "wi-1",
                platform: "github",
                platformKey: ITEM.platformKey,
                outcome: "created",
              },
            ],
            counts: { created: 1, updated: 0, unchanged: 0 },
          },
        }),
      ),
      createTaskRunWorkItem: vi.fn(),
      latestTaskRunSourceUpdate: vi.fn(),
    } satisfies TaskRunWorkItemsApi;
    const opened: OpenMcpBridgeSessionInput[] = [];
    const { deps, tracker } = buildCodeStepDeps({
      workspacePath,
      entrypointJson: { sourceFile: "steps/poll.ts" },
      runCodeStepCommand: input.runCodeStepCommand,
      grants: input.grants,
      workItems,
      openMcpBridgeSession: (openInput) => {
        opened.push(openInput);
        return openMcpBridgeSession({ ...openInput, bindAddress: "127.0.0.1" });
      },
    });
    const log = vi.fn<(scope: string, message: string) => void>();
    deps.logger = { debug: vi.fn(), log, error: vi.fn() };
    const logStream = {
      registerSecretValues: vi.fn(),
      attachOpencodeTail: vi.fn(),
      attachConversationStream: vi.fn(),
      shipDevcontainerLogLine: vi.fn(),
    };
    await startProcessClaimedTaskRun(
      {
        projectId,
        requestedByUserId,
        claim: { task: { id: taskRunId }, claimToken: CLAIM_TOKEN },
        leaseDurationSeconds: 30,
      },
      deps,
      deps.workerClient,
      tracker,
      logStream,
    );
    return { workItems, opened, logStream, log };
  }

  test("reaches the API through the bridge with the claim token, which never enters the runner", async () => {
    const responses: { status: number; body: unknown }[] = [];
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(async (command) => {
      const env = command.env ?? {};
      // The runner is in a container (host.docker.internal); here the test
      // stands in for it on the worker host.
      const bridgeUrl = String(env[STEP_BRIDGE_URL_ENV]).replace(
        "host.docker.internal",
        "127.0.0.1",
      );
      const response = await fetch(
        `${bridgeUrl}${STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${String(env[STEP_BRIDGE_TOKEN_ENV])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ items: [ITEM] }),
        },
      );
      responses.push({
        status: response.status,
        body: (await response.json()) as unknown,
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const { workItems, opened, logStream, log } = await runStep({
      grants: [
        {
          resource: "workItem",
          action: "create",
          scope: "project",
          labels: [],
        },
        { resource: "workItem", action: "update", scope: "project" },
      ],
      runCodeStepCommand,
    });

    expect(opened).toHaveLength(1);
    expect(opened[0]?.servers).toEqual({});
    expect(opened[0]?.placement).toMatchObject({
      kind: "container",
      containerId: "runtime-container-id",
    });
    expect(responses).toEqual([
      {
        status: 200,
        body: expect.objectContaining({
          counts: { created: 1, updated: 0, unchanged: 0 },
        }) as unknown,
      },
    ]);
    expect(workItems.upsertTaskRunWorkItems).toHaveBeenCalledWith({
      taskRunId,
      claimToken: CLAIM_TOKEN,
      items: [ITEM],
    });

    const env = runCodeStepCommand.mock.calls[0]?.[0].env ?? {};
    const bridgeToken = String(env[STEP_BRIDGE_TOKEN_ENV]);
    expect(bridgeToken).toMatch(/^[0-9a-f]{64}$/);
    expect(logStream.registerSecretValues).toHaveBeenCalledWith([bridgeToken]);
    expect(JSON.stringify(runCodeStepCommand.mock.calls)).not.toContain(
      CLAIM_TOKEN,
    );

    const lines = log.mock.calls;
    expect(lines.map((call) => call[1])).toContainEqual(
      expect.stringMatching(
        /^work-items: upsert 1 \(1 created, 0 updated, 0 unchanged\) in \d+\.\ds$/,
      ) as string,
    );
    expect(JSON.stringify(lines)).not.toContain(bridgeToken);
  });

  test("opens no bridge for a code step with neither mcps nor a project grant", async () => {
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const { opened } = await runStep({ grants: [], runCodeStepCommand });
    expect(opened).toHaveLength(0);
    expect(runCodeStepCommand.mock.calls[0]?.[0].env ?? {}).not.toHaveProperty(
      STEP_BRIDGE_TOKEN_ENV,
    );
  });
});
