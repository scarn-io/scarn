import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsageMeterRepo } from "@scarn/core/billing/usage-meter/application/usage-meter-repo";
import { currentBillingPeriod } from "@scarn/core/billing/usage-meter/domain/billing-period";
import { UsageLimitReachedDomainEvent } from "@scarn/core/billing/usage-meter/domain/usage-limit-reached.domain-event";
import {
  issueWorkSignalTokenInputSchema,
  type IssueWorkSignalTokenInput,
  type WorkSignalTokenContract,
} from "../contracts/work-signal-token-contracts";
import { signWorkSignalToken } from "../domain/work-signal-token";
import type { WorkSignalConnectionConfig } from "./work-signal";

const WORK_SIGNAL_TOKEN_TTL_SECONDS = 60 * 60;

export type IssueWorkSignalTokenDeps = {
  userAuthz: UserAuthorizationService;
  orgRepo: Pick<OrgRepo, "findByProjectId">;
  usageMeterRepo: Pick<UsageMeterRepo, "loadOrStart" | "save">;
  domainEventDispatcher: Pick<InMemoryDomainEventDispatcher, "publish">;
  workSignalConnection: WorkSignalConnectionConfig | null;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * Issues a 60-minute token a worker uses to subscribe to push wake-ups for a
 * project. Requires the same permission as claiming. The token carries the
 * project's org id so the edge Worker can limit and meter per org.
 *
 * Each issued token counts as one push session against the org's monthly
 * meter, recorded under the meter row's lock before the token is signed. At
 * the cap it throws a 402 `USAGE_LIMIT_EXCEEDED_SIGNAL` and signs nothing. 404s
 * when push is not configured, which workers read as "keep polling", and when
 * the project has no org; neither records a session.
 */
export const issueWorkSignalToken = async (
  projectId: UuidV7,
  input: IssueWorkSignalTokenInput,
  deps: IssueWorkSignalTokenDeps,
): Promise<WorkSignalTokenContract> => {
  const { userAuthz, workSignalConnection, timeProvider } = deps;
  if (!workSignalConnection) {
    throw new CoreError({
      code: "WORK_SIGNAL_NOT_CONFIGURED",
      message: "Push wake-ups are not configured",
      status: 404,
    });
  }
  const parsedInput = issueWorkSignalTokenInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:write",
  });

  const orgId = await (deps.dbExecutor ?? getDb()).transaction(
    async (tx) => await recordPushSession(projectId, deps, tx),
  );

  const exp =
    Math.floor(timeProvider.now().getTime() / 1000) +
    WORK_SIGNAL_TOKEN_TTL_SECONDS;
  const token = await signWorkSignalToken(
    {
      pid: projectId,
      oid: orgId,
      sub: parsedInput.workerId ?? userAuthz.actorId,
      exp,
    },
    workSignalConnection.tokenSecret,
  );
  return {
    url: workSignalConnection.url,
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
};

const recordPushSession = async (
  projectId: UuidV7,
  {
    orgRepo,
    usageMeterRepo,
    domainEventDispatcher,
    timeProvider,
  }: IssueWorkSignalTokenDeps,
  tx: DbTransaction,
): Promise<UuidV7> => {
  const org = await orgRepo.findByProjectId(projectId, tx);
  if (!org) {
    throw new ResourceNotFoundError("Organization", `for project ${projectId}`);
  }

  const period = currentBillingPeriod(timeProvider.now());
  const meter = await usageMeterRepo.loadOrStart(
    org.id,
    period,
    defaultPlanId(),
    tx,
  );
  const nextMeter = meter.recordSignalToken();
  await usageMeterRepo.save(nextMeter, tx);

  if (nextMeter.limitReached) {
    await domainEventDispatcher.publish(
      [
        new UsageLimitReachedDomainEvent({
          orgId: nextMeter.orgId,
          period: nextMeter.period,
          kind: nextMeter.limitReached,
        }),
      ],
      tx,
    );
  }
  return org.id;
};
