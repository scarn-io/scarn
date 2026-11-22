import { describe, expect, vi } from "bun:test";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@/organizations/organization/application/org-repo";
import type { OrganizationEntity } from "@/organizations/organization/domain/organization-entity";
import type { DbExecutor } from "@/lib/db/db-executor";
import type { DomainEvent } from "@/lib/domain-events/domain-event";
import { UsageMeter } from "@/billing/usage-meter/domain/usage-meter-entity";
import { PLAN_LIMITS_CONFIG } from "@/billing/plan/domain/plan-limits";
import {
  issueWorkSignalToken,
  type IssueWorkSignalTokenDeps,
} from "@/tasks/task-run/application/issue-work-signal-token";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const PERIOD = "2026-07";
const SIGNAL_CAP = PLAN_LIMITS_CONFIG.free.maxSignalTokensPerMonth;

const WORK_SIGNAL = {
  url: "https://signal.example.com",
  tokenSecret: "work-signal-secret",
};

const fakeAuthz = (): UserAuthorizationService => ({
  actorId: createUuidV7(),
  requireProjectMember: () =>
    Promise.reject(new Error("requireProjectMember is not used here")),
  requireProjectPermission: vi.fn(() =>
    Promise.resolve({ membership: null, isPublicNonMemberGrant: false }),
  ),
});

const fakeOrgRepo = (
  orgId: UuidV7 | null,
): Pick<OrgRepo, "findByProjectId"> => ({
  findByProjectId: vi.fn(() =>
    Promise.resolve(
      orgId ? ({ id: orgId } as unknown as OrganizationEntity) : null,
    ),
  ),
});

/**
 * An in-memory meter store keyed by the single org under test, plus a
 * captured-events dispatcher and an executor whose `transaction` runs inline.
 */
const fakeMetering = (orgId: UuidV7, signalTokens = 0) => {
  let meter = UsageMeter.rehydrate({
    orgId,
    period: PERIOD,
    planId: "free",
    writes: 0,
    reads: 0,
    storageBytes: 0,
    signalTokens,
  });
  const published: DomainEvent[] = [];
  const deps: Pick<
    IssueWorkSignalTokenDeps,
    "usageMeterRepo" | "domainEventDispatcher" | "dbExecutor"
  > = {
    usageMeterRepo: {
      loadOrStart: vi.fn(() => Promise.resolve(meter)),
      save: vi.fn((next: UsageMeter) => {
        meter = next;
        return Promise.resolve(next);
      }),
    },
    domainEventDispatcher: {
      publish: vi.fn((events: DomainEvent[]) => {
        published.push(...events);
        return Promise.resolve();
      }),
    },
    dbExecutor: {
      transaction: <T>(fn: (tx: never) => Promise<T>) => fn({} as never),
    } as unknown as DbExecutor,
  };
  return { deps, published, signalTokens: () => meter.signalTokens };
};

const decodePayload = (token: string): unknown =>
  JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  );

const rejectionOf = async <T>(promise: Promise<T>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
};

describe("issueWorkSignalToken", () => {
  concurrentTest(
    "signs a 60-minute token carrying the project's org id",
    async () => {
      const projectId = createUuidV7();
      const orgId = createUuidV7();

      const issued = await issueWorkSignalToken(
        projectId,
        { workerId: "worker-a" },
        {
          userAuthz: fakeAuthz(),
          orgRepo: fakeOrgRepo(orgId),
          ...fakeMetering(orgId).deps,
          workSignalConnection: WORK_SIGNAL,
          timeProvider: fixedTimeProvider(NOW),
        },
      );

      const exp = NOW.getTime() / 1000 + 60 * 60;
      expect(issued.url).toBe(WORK_SIGNAL.url);
      expect(issued.expiresAt).toBe(new Date(exp * 1000).toISOString());
      expect(decodePayload(issued.token)).toEqual({
        pid: projectId,
        oid: orgId,
        sub: "worker-a",
        exp,
      });
    },
  );

  concurrentTest("404s when the project has no org", async () => {
    const error = await rejectionOf(
      issueWorkSignalToken(
        createUuidV7(),
        {},
        {
          userAuthz: fakeAuthz(),
          orgRepo: fakeOrgRepo(null),
          ...fakeMetering(createUuidV7()).deps,
          workSignalConnection: WORK_SIGNAL,
          timeProvider: fixedTimeProvider(NOW),
        },
      ),
    );

    expect(error).toMatchObject({
      code: "ORGANIZATION_NOT_FOUND",
      status: 404,
    });
  });

  concurrentTest("404s when push is not configured", async () => {
    const orgId = createUuidV7();
    const metering = fakeMetering(orgId);
    const error = await rejectionOf(
      issueWorkSignalToken(
        createUuidV7(),
        {},
        {
          userAuthz: fakeAuthz(),
          orgRepo: fakeOrgRepo(orgId),
          ...metering.deps,
          workSignalConnection: null,
          timeProvider: fixedTimeProvider(NOW),
        },
      ),
    );

    expect(error).toMatchObject({
      code: "WORK_SIGNAL_NOT_CONFIGURED",
      status: 404,
    });
    expect(metering.signalTokens()).toBe(0);
  });

  concurrentTest("records one push session per issued token", async () => {
    const orgId = createUuidV7();
    const metering = fakeMetering(orgId);
    const deps = {
      userAuthz: fakeAuthz(),
      orgRepo: fakeOrgRepo(orgId),
      ...metering.deps,
      workSignalConnection: WORK_SIGNAL,
      timeProvider: fixedTimeProvider(NOW),
    };

    await issueWorkSignalToken(createUuidV7(), {}, deps);
    await issueWorkSignalToken(createUuidV7(), {}, deps);

    expect(metering.signalTokens()).toBe(2);
    expect(metering.published).toEqual([]);
  });

  concurrentTest(
    "402s at the cap without signing or recording a session",
    async () => {
      const orgId = createUuidV7();
      const metering = fakeMetering(orgId, SIGNAL_CAP);

      const error = await rejectionOf(
        issueWorkSignalToken(
          createUuidV7(),
          {},
          {
            userAuthz: fakeAuthz(),
            orgRepo: fakeOrgRepo(orgId),
            ...metering.deps,
            workSignalConnection: WORK_SIGNAL,
            timeProvider: fixedTimeProvider(NOW),
          },
        ),
      );

      expect(error).toMatchObject({
        code: "USAGE_LIMIT_EXCEEDED_SIGNAL",
        status: 402,
      });
      expect(metering.signalTokens()).toBe(SIGNAL_CAP);
      expect(metering.deps.usageMeterRepo.save).not.toHaveBeenCalled();
      expect(metering.published).toEqual([]);
    },
  );

  concurrentTest(
    "publishes UsageLimitReached on the issue that reaches the cap",
    async () => {
      const orgId = createUuidV7();
      const metering = fakeMetering(orgId, SIGNAL_CAP - 1);

      const issued = await issueWorkSignalToken(
        createUuidV7(),
        {},
        {
          userAuthz: fakeAuthz(),
          orgRepo: fakeOrgRepo(orgId),
          ...metering.deps,
          workSignalConnection: WORK_SIGNAL,
          timeProvider: fixedTimeProvider(NOW),
        },
      );

      expect(issued.token).toBeString();
      expect(metering.signalTokens()).toBe(SIGNAL_CAP);
      expect(metering.published).toMatchObject([
        {
          type: "usage.limit-reached",
          payload: { orgId, period: PERIOD, kind: "signal" },
        },
      ]);
    },
  );
});
