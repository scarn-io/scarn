import type { TaskLogLinesResult } from "@scarn/shared-core";
import type { ArtifactKind } from "@scarn/sdk/contracts/artifacts";
import type { UuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type {
  TaskLogLine,
  TaskRunWorkerClaim,
  TaskRunWorkerClient,
} from "../../../../../src/work/task-run/contracts/process-project-work-types";
import type {
  TaskRunContract,
  TaskRunWorkerContextContract,
} from "../../../../../src/work/task-run/contracts/task-run-contracts";
import { createUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type { WorkScenario } from "./scenario";

export type FailTaskRunCall = {
  taskRunId: UuidV7;
  claimToken: string;
  resultJson: unknown;
  errorJson: unknown;
};

export type CompleteTaskRunCall = FailTaskRunCall & {
  workBranch: string | null;
  createdFromBranch: string | null;
  sessionRestored?: boolean | null | undefined;
};

export type YieldTaskRunCall = Parameters<
  TaskRunWorkerClient["yieldTaskRun"]
>[0];

export type HeartbeatTaskRunCall = {
  taskRunId: UuidV7;
  claimToken: string;
  leaseDurationSeconds: number;
};

/**
 * In-memory programmable TaskRunWorkerClient. Replaces the real HTTP
 * worker-api-client so integration tests don't need a running platform server.
 *
 * - claimTaskRuns hands out the scenario's steps exactly once, then
 *   returns [] so the polling loop terminates.
 * - getTaskRunWorkerContext returns the scenario's worker context.
 * - getTaskRun reports "running" until the step is completed/failed,
 *   then reflects that terminal status.
 * - complete/fail/yield/heartbeat calls are recorded for assertions.
 */
export class FakeTaskRunWorkerClient implements TaskRunWorkerClient {
  readonly userId: UuidV7;

  readonly completeCalls: CompleteTaskRunCall[] = [];
  readonly failCalls: FailTaskRunCall[] = [];
  readonly yieldCalls: YieldTaskRunCall[] = [];
  readonly heartbeatCalls: HeartbeatTaskRunCall[] = [];

  private claimsDispensed = false;
  private readonly claimTokensByStep = new Map<string, string>();
  private readonly terminalStatusByStep = new Map<
    string,
    TaskRunContract["status"]
  >();

  readonly loadTaskLogLinesCalls: string[] = [];

  constructor(
    private readonly scenario: WorkScenario,
    private readonly taskLogLines?: (taskRunId: string) => TaskLogLinesResult,
  ) {
    this.userId = createUuidV7();
  }

  loadTaskLogLines(input: { taskRunId: string }): Promise<TaskLogLinesResult> {
    this.loadTaskLogLinesCalls.push(input.taskRunId);
    return Promise.resolve(
      this.taskLogLines?.(input.taskRunId) ?? {
        unavailable: "no logs configured for this scenario",
      },
    );
  }

  claimTaskRuns(input: {
    projectId: UuidV7;
    workerId: string;
    batchSize: number;
    leaseDurationSeconds: number;
    workItemId?: string | undefined;
  }): Promise<TaskRunWorkerClaim[]> {
    if (this.claimsDispensed) {
      return Promise.resolve([]);
    }
    this.claimsDispensed = true;

    const claims: TaskRunWorkerClaim[] = this.scenario.steps
      .slice(0, input.batchSize)
      .map((step) => {
        const claimToken = createUuidV7();
        this.claimTokensByStep.set(step.taskRunId, claimToken);
        return {
          task: { id: step.taskRunId },
          claimToken,
        };
      });

    return Promise.resolve(claims);
  }

  readonly appendedLogLines: TaskLogLine[] = [];

  appendTaskLogs(input: {
    taskRunId: UuidV7;
    claimToken: string;
    lines: TaskLogLine[];
  }): Promise<{ nextOffset: number }> {
    this.appendedLogLines.push(...input.lines);
    const last = input.lines[input.lines.length - 1];
    return Promise.resolve({ nextOffset: last ? last.seq : 0 });
  }

  heartbeatTaskRun(input: {
    taskRunId: UuidV7;
    claimToken: string;
    leaseDurationSeconds: number;
  }): Promise<void> {
    this.heartbeatCalls.push({ ...input });
    return Promise.resolve();
  }

  failTaskRun(input: {
    taskRunId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
  }): Promise<void> {
    this.failCalls.push({ ...input });
    this.terminalStatusByStep.set(input.taskRunId, "failed");
    return Promise.resolve();
  }

  completeTaskRun(input: CompleteTaskRunCall): Promise<void> {
    this.completeCalls.push({ ...input });
    this.terminalStatusByStep.set(input.taskRunId, "succeeded");
    return Promise.resolve();
  }

  yieldTaskRun(input: YieldTaskRunCall): Promise<void> {
    this.yieldCalls.push({ ...input });
    this.terminalStatusByStep.set(input.taskRunId, "yielded");
    return Promise.resolve();
  }

  getTaskRun(input: {
    taskRunId: UuidV7;
  }): Promise<Pick<TaskRunContract, "status">> {
    return Promise.resolve({
      status: this.terminalStatusByStep.get(input.taskRunId) ?? "running",
    });
  }

  getTaskRunWorkerContext(input: {
    taskRunId: UuidV7;
    claimToken: string;
  }): Promise<TaskRunWorkerContextContract> {
    const step = this.scenario.steps.find(
      (candidate) => candidate.taskRunId === input.taskRunId,
    );

    if (!step) {
      throw new Error(
        `No scenario step configured for taskRunId=${input.taskRunId}`,
      );
    }

    return Promise.resolve(step.workerContext);
  }

  readonly artifactUploadUrlCalls: {
    taskRunId: string;
    claimToken: string;
    relativeStorePath: string;
    contentType?: string | undefined;
  }[] = [];

  readonly recordedArtifacts: {
    taskRunId: string;
    claimToken: string;
    objectKey: string;
    relativeStorePath: string;
    sizeBytes: number;
    contentType?: string | undefined;
    kind: ArtifactKind;
  }[] = [];

  createArtifactUploadUrl(input: {
    taskRunId: string;
    claimToken: string;
    relativeStorePath: string;
    contentType?: string | undefined;
  }): Promise<{
    uploadUrl: string;
    storeRef: string;
    objectKey: string;
    expiresInSeconds: number;
  }> {
    this.artifactUploadUrlCalls.push({ ...input });
    const objectKey = `${input.taskRunId}/${input.relativeStorePath}`;
    return Promise.resolve({
      uploadUrl: `https://fake-upload.local/${objectKey}`,
      storeRef: `remote://${objectKey}`,
      objectKey,
      expiresInSeconds: 300,
    });
  }

  readonly sessionUploadUrlCalls: {
    taskRunId: string;
    claimToken: string;
    sizeBytes?: number | undefined;
  }[] = [];

  createSessionUploadUrl(input: {
    taskRunId: string;
    claimToken: string;
    sizeBytes?: number | undefined;
  }): Promise<{
    uploadUrl: string;
    objectKey: string;
    expiresInSeconds: number;
  }> {
    this.sessionUploadUrlCalls.push({ ...input });
    const objectKey = `tasks/${input.taskRunId}/session.json`;
    return Promise.resolve({
      uploadUrl: `https://fake-upload.local/${objectKey}`,
      objectKey,
      expiresInSeconds: 900,
    });
  }

  recordArtifact(input: {
    taskRunId: string;
    claimToken: string;
    objectKey: string;
    relativeStorePath: string;
    sizeBytes: number;
    contentType?: string | undefined;
    kind: ArtifactKind;
  }): Promise<void> {
    this.recordedArtifacts.push({ ...input });
    return Promise.resolve();
  }

  readonly recordedArtifactFailures: {
    taskRunId: string;
    claimToken: string;
    relativeStorePath: string;
    attemptedSizeBytes: number;
    kind?: ArtifactKind | undefined;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number | undefined;
  }[] = [];

  recordArtifactFailure(input: {
    taskRunId: string;
    claimToken: string;
    relativeStorePath: string;
    attemptedSizeBytes: number;
    kind?: ArtifactKind | undefined;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number | undefined;
  }): Promise<void> {
    this.recordedArtifactFailures.push({ ...input });
    return Promise.resolve();
  }
}
