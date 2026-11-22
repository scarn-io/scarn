import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { assertClaimOwnership } from "@scarn/core/tasks/task-run/application/task-run-claim-helpers";
import { taskIdInputSchema } from "../contracts/task-log-contracts";
import {
  issueLogFeedWriteTokenInputSchema,
  type IssueLogFeedWriteTokenInput,
  type LogFeedTokenContract,
} from "../contracts/log-feed-token-contracts";
import {
  signLogFeedToken,
  type LogFeedTokenScope,
} from "../domain/log-feed-token";
import type { LogFeedConnectionConfig } from "./log-feed-store";

const LOG_FEED_TOKEN_TTL_SECONDS = 15 * 60;

/** `LOG_FEED_URL` as the WebSocket URL of one task run's feed (http→ws, https→wss). */
export const logFeedSocketUrl = (baseUrl: string, taskRunId: string): string =>
  `${baseUrl.replace(/^http/, "ws")}/task-runs/${encodeURIComponent(taskRunId)}/ws`;

/**
 * Signs a 15-minute feed token for one task run and pairs it with the feed's
 * socket URL. `oid` is the run's project's org id, which callers resolve once
 * per request.
 */
export const buildLogFeedToken = async (
  taskRun: { id: string; projectId: string },
  oid: string,
  scope: LogFeedTokenScope,
  {
    logFeedConnection,
    timeProvider,
  }: {
    logFeedConnection: LogFeedConnectionConfig;
    timeProvider: TimeProvider;
  },
): Promise<LogFeedTokenContract> => {
  const exp =
    Math.floor(timeProvider.now().getTime() / 1000) +
    LOG_FEED_TOKEN_TTL_SECONDS;
  const token = await signLogFeedToken(
    { tid: taskRun.id, pid: taskRun.projectId, oid, scope, exp },
    logFeedConnection.tokenSecret,
  );
  return {
    url: logFeedSocketUrl(logFeedConnection.url, taskRun.id),
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
};

const requireLogFeedConnection = (
  logFeedConnection: LogFeedConnectionConfig | null,
): LogFeedConnectionConfig => {
  if (!logFeedConnection) {
    throw new CoreError({
      code: "LOG_FEED_NOT_CONFIGURED",
      message: "The live log feed is not configured",
      status: 404,
    });
  }
  return logFeedConnection;
};

type IssueLogFeedTokenDeps = {
  userAuthz: UserAuthorizationService;
  taskRunRepo: TaskRunRepo;
  orgRepo: Pick<OrgRepo, "findByProjectId">;
  logFeedConnection: LogFeedConnectionConfig | null;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * Worker-only: refresh the write token for a task run's live log feed. Same
 * auth as appending logs: `executions:write` plus the current claim token.
 * 404s when the feed is not configured or the project has no org, which
 * workers read as "append over HTTP".
 */
export const issueLogFeedWriteToken = async (
  taskIdInput: string,
  input: IssueLogFeedWriteTokenInput,
  {
    userAuthz,
    taskRunRepo,
    orgRepo,
    logFeedConnection,
    timeProvider,
    dbExecutor,
  }: IssueLogFeedTokenDeps,
): Promise<Result<LogFeedTokenContract, ResourceNotFoundError>> => {
  const connection = requireLogFeedConnection(logFeedConnection);
  const taskRunId = taskIdInputSchema.parse(taskIdInput);
  const parsedInput = issueLogFeedWriteTokenInputSchema.parse(input);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:write",
  });
  assertClaimOwnership(task, parsedInput.claimToken, timeProvider.now());
  const org = await orgRepo.findByProjectId(task.projectId, dbExecutor);
  if (!org) {
    return Result.err(
      new ResourceNotFoundError(
        "Organization",
        `for project ${task.projectId}`,
      ),
    );
  }

  return Result.ok(
    await buildLogFeedToken(task, org.id, "write", {
      logFeedConnection: connection,
      timeProvider,
    }),
  );
};

/**
 * UI read path: a read token for a task run's live log feed. Requires
 * `executions:read`, which public projects grant to anyone. 404s when the feed
 * is not configured or the project has no org, which the UI reads as "poll
 * over HTTP".
 */
export const issueLogFeedReadToken = async (
  taskIdInput: string,
  {
    userAuthz,
    taskRunRepo,
    orgRepo,
    logFeedConnection,
    timeProvider,
    dbExecutor,
  }: IssueLogFeedTokenDeps,
): Promise<Result<LogFeedTokenContract, ResourceNotFoundError>> => {
  const connection = requireLogFeedConnection(logFeedConnection);
  const taskRunId = taskIdInputSchema.parse(taskIdInput);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });
  const org = await orgRepo.findByProjectId(task.projectId, dbExecutor);
  if (!org) {
    return Result.err(
      new ResourceNotFoundError(
        "Organization",
        `for project ${task.projectId}`,
      ),
    );
  }

  return Result.ok(
    await buildLogFeedToken(task, org.id, "read", {
      logFeedConnection: connection,
      timeProvider,
    }),
  );
};
