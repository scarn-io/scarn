import type {
  CreatedWorkItem,
  StepBridgeCreateRequest,
  StepBridgeErrorResponse,
  StepBridgeSourceCursorRequest,
  StepBridgeSourceCursorResponse,
  StepBridgeUpsertRequest,
  StepBridgeUpsertResponse,
} from "@scarn/sdk/contracts/step-bridge";
import type {
  ProjectWorkLogger,
  TaskRunWorkItemsApi,
  TaskRunWorkItemsApiResponse,
} from "../../../work/task-run/contracts/process-project-work-types";
import { formatCallDuration } from "../../../work/task-run/application/mcp-tool-step-observability";

/**
 * Answers a code step's `context.workItems` calls for one run (ADR 0018):
 * each call goes to the API's code-step work-item routes with the run's claim
 * token, which the step never sees. The API decides what the call may do (the
 * step's grants and the claiming user's permissions); this only relays.
 *
 *   - A 2xx answer becomes a 200 with the API's body unchanged (a `create`
 *     answers 201 for a new item).
 *   - Any other answer keeps the API's status, with its `code` and `meta`.
 *   - An API that can't be reached is a 502.
 *
 * Every call logs one task-log line, e.g.
 * `work-items: upsert 37 (12 created, 20 updated, 5 unchanged) in 1.2s`.
 * Lines never carry item content.
 */

const LOG_SCOPE = "step";

export type WorkItemsBridgeResult = {
  status: number;
  /** The API's 200 body as is, or a `StepBridgeErrorResponse`. */
  body: object;
};

export type WorkItemsBridgeOptions = {
  taskRunId: string;
  claimToken: string;
  api: TaskRunWorkItemsApi;
  logger?: ProjectWorkLogger | undefined;
  now?: (() => number) | undefined;
};

export class WorkItemsBridge {
  private readonly taskRunId: string;
  private readonly claimToken: string;
  private readonly api: TaskRunWorkItemsApi;
  private readonly logger: ProjectWorkLogger | undefined;
  private readonly now: () => number;

  constructor(options: WorkItemsBridgeOptions) {
    this.taskRunId = options.taskRunId;
    this.claimToken = options.claimToken;
    this.api = options.api;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async upsert(
    request: StepBridgeUpsertRequest,
  ): Promise<WorkItemsBridgeResult> {
    const count = request.items.length;
    return await this.forward(
      `upsert ${String(count)}`,
      () =>
        this.api.upsertTaskRunWorkItems({
          taskRunId: this.taskRunId,
          claimToken: this.claimToken,
          items: request.items,
        }),
      (body) => {
        const { counts } = body as StepBridgeUpsertResponse;
        return `(${String(counts.created)} created, ${String(counts.updated)} updated, ${String(counts.unchanged)} unchanged)`;
      },
    );
  }

  async create(
    request: StepBridgeCreateRequest,
  ): Promise<WorkItemsBridgeResult> {
    return await this.forward(
      "create",
      () =>
        this.api.createTaskRunWorkItem({
          ...request,
          taskRunId: this.taskRunId,
          claimToken: this.claimToken,
          workItemId: Bun.randomUUIDv7(),
          scope: "project",
        }),
      (body) =>
        (body as CreatedWorkItem).created ? "(created)" : "(existing)",
    );
  }

  async sourceCursor(
    request: StepBridgeSourceCursorRequest,
  ): Promise<WorkItemsBridgeResult> {
    return await this.forward(
      `source-cursor ${request.platform}`,
      () =>
        this.api.latestTaskRunSourceUpdate({
          ...request,
          taskRunId: this.taskRunId,
          claimToken: this.claimToken,
        }),
      (body) =>
        (body as StepBridgeSourceCursorResponse).sourceUpdatedAt === null
          ? "(none)"
          : "(found)",
    );
  }

  /** `describe` reads the API's 200 body for the route `call` sends to. */
  private async forward(
    label: string,
    call: () => Promise<TaskRunWorkItemsApiResponse>,
    describe: (body: object) => string,
  ): Promise<WorkItemsBridgeResult> {
    const startedAt = this.now();
    const elapsed = () => formatCallDuration(this.now() - startedAt);
    let response: TaskRunWorkItemsApiResponse;
    try {
      response = await call();
    } catch {
      this.log(`work-items: ${label} failed in ${elapsed()} (API unreachable)`);
      return {
        status: 502,
        body: errorBody("The worker couldn't reach the Scarn API"),
      };
    }
    if (response.status >= 200 && response.status < 300) {
      const body = response.body as object;
      this.log(`work-items: ${label} ${describe(body)} in ${elapsed()}`);
      return { status: 200, body };
    }
    const error = apiError(response);
    this.log(
      `work-items: ${label} failed in ${elapsed()} (HTTP ${String(response.status)}${error.code ? ` ${error.code}` : ""})`,
    );
    return { status: response.status, body: error };
  }

  private log(message: string): void {
    this.logger?.log(LOG_SCOPE, message, { taskRunId: this.taskRunId });
  }
}

function errorBody(error: string): StepBridgeErrorResponse {
  return { error };
}

/** The API's problem body as a bridge error: its `detail` (or `title`), `code` and `meta`. */
function apiError(
  response: TaskRunWorkItemsApiResponse,
): StepBridgeErrorResponse {
  const problem =
    typeof response.body === "object" && response.body !== null
      ? (response.body as Record<string, unknown>)
      : {};
  const message =
    stringField(problem, "detail") ??
    stringField(problem, "title") ??
    `The Scarn API answered HTTP ${String(response.status)}`;
  const code = stringField(problem, "code");
  const meta = problem["meta"];
  return {
    error: message,
    ...(code === undefined ? {} : { code }),
    ...(typeof meta === "object" && meta !== null && !Array.isArray(meta)
      ? { meta: meta as Record<string, unknown> }
      : {}),
  };
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
