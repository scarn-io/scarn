import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedConnectionEntity,
  type ManagedConnectionEntity as ManagedConnection,
  type ServingManagedConnectionEntity,
} from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import {
  launchClaimTokenDigest,
  randomRelayCapability,
  relayCapabilityDigest,
} from "@/connections/managed-mcp-connection/domain/managed-launch-digests";
import { ManagedLaunchConnectionEntity } from "@/connections/managed-mcp-connection/domain/managed-launch-connection-entity";
import {
  decideSealAuthority,
  isManagedConnectionAuthorityLost,
  managedAuthorityLostError,
  MANAGED_CONNECTION_AUTHORITY_LOST,
  type ManagedAuthorityLoss,
  type ManagedSealAuthorityCheck,
} from "@/connections/managed-mcp-connection/domain/managed-seal-authority";
import { namedRunError } from "@/tasks/task/domain/run-error";
import { concurrentTest } from "tests/utils";
import { managedConnectionDefinitionFromPreset } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";

const NOTION_CONNECTION = managedConnectionDefinitionFromPreset("notion");

const T0 = new Date("2026-11-18T10:00:00.000Z");
const T1 = new Date("2026-11-18T10:01:00.000Z");
const projectId = createUuidV7();
const noClaim = { refreshClaim: null };
const claimed = { refreshClaim: { claimId: createUuidV7(), claimedAt: T0 } };

const ready = (): ServingManagedConnectionEntity => {
  const grantId = createUuidV7();
  const connection = ManagedConnectionEntity.create({
    projectId,
    ...NOTION_CONNECTION,
    now: T0,
  })
    .startConnect(T0)
    .attachCandidate(grantId, T0)
    .confirmCandidate(grantId, "fingerprint", {
      candidateFingerprint: "fingerprint",
      confirmedByUserId: createUuidV7(),
      now: T0,
    });
  if (connection.state !== "ready") {
    throw new Error("expected ready");
  }
  return connection;
};

const launchFor = (
  connection: ServingManagedConnectionEntity,
  key = "notion",
) =>
  ManagedLaunchConnectionEntity.create({
    projectId,
    taskRunId: createUuidV7(),
    claimTokenDigest: launchClaimTokenDigest("claim"),
    entryKey: key,
    connection,
    capabilityDigest: relayCapabilityDigest(randomRelayCapability()),
    now: T0,
  });

const check = (
  launch: ManagedLaunchConnectionEntity,
  connection: ManagedConnection | null,
  servingGrant: ManagedSealAuthorityCheck["servingGrant"] = noClaim,
): ManagedSealAuthorityCheck => ({ launch, connection, servingGrant });

const operation = (launchConnectionId: UuidV7, deadlineAt: Date) => ({
  launchConnectionId,
  deadlineAt,
});

describe("decideSealAuthority", () => {
  concurrentTest("no open launch is authorized", () => {
    expect(decideSealAuthority([], [], T1)).toEqual({ kind: "authorized" });
  });

  concurrentTest("a launch its connection still authorizes seals", () => {
    const connection = ready();
    expect(
      decideSealAuthority([check(launchFor(connection), connection)], [], T1),
    ).toEqual({ kind: "authorized" });
  });

  concurrentTest(
    "disconnect, reconnect required and a missing row are losses",
    () => {
      const connection = ready();
      const launch = launchFor(connection);
      const reasonOf = (current: ManagedConnection | null) => {
        const decision = decideSealAuthority(
          [check(launch, current, null)],
          [],
          T1,
        );
        return decision.kind === "lost" ? decision.losses[0]?.reason : null;
      };
      expect(reasonOf(connection.disconnect(T1))).toBe("disconnected");
      expect(reasonOf(connection.requireReconnect("refresh_failed", T1))).toBe(
        "reconnect_required",
      );
      expect(reasonOf(null)).toBe("disconnected");
    },
  );

  concurrentTest("an operation past its deadline is operation_unknown", () => {
    const connection = ready();
    const launch = launchFor(connection);
    expect(
      decideSealAuthority(
        [check(launch, connection)],
        [operation(launch.id, T1)],
        T1,
      ),
    ).toEqual({
      kind: "lost",
      losses: [
        {
          launchConnectionId: launch.id,
          connectionId: connection.id,
          label: "Notion",
          reason: "operation_unknown",
        },
      ],
    });
  });

  concurrentTest("an operation before its deadline blocks", () => {
    const connection = ready();
    const launch = launchFor(connection);
    expect(
      decideSealAuthority(
        [check(launch, connection)],
        [operation(launch.id, new Date(T1.getTime() + 1))],
        T1,
      ),
    ).toEqual({ kind: "blocked", code: "MANAGED_OPERATION_IN_FLIGHT" });
  });

  concurrentTest("a refresh claim, fresh or stale, blocks", () => {
    const connection = ready();
    const launch = launchFor(connection);
    for (const now of [T1, new Date(T0.getTime() + 3_600_000)]) {
      expect(
        decideSealAuthority([check(launch, connection, claimed)], [], now),
      ).toEqual({
        kind: "blocked",
        code: "MANAGED_CONNECTION_REFRESH_PENDING",
      });
    }
  });

  concurrentTest(
    "loss beats an in-flight operation, which beats a refresh",
    () => {
      const connection = ready();
      const lostLaunch = launchFor(connection, "a");
      const liveLaunch = launchFor(connection, "b");
      const inFlight = operation(liveLaunch.id, new Date(T1.getTime() + 1));
      expect(
        decideSealAuthority(
          [
            check(lostLaunch, connection.disconnect(T1), null),
            check(liveLaunch, connection, claimed),
          ],
          [inFlight],
          T1,
        ).kind,
      ).toBe("lost");
      expect(
        decideSealAuthority(
          [check(liveLaunch, connection, claimed)],
          [inFlight],
          T1,
        ),
      ).toEqual({ kind: "blocked", code: "MANAGED_OPERATION_IN_FLIGHT" });
    },
  );
});

const loss = (
  label: string | null,
  reason: ManagedAuthorityLoss["reason"] = "disconnected",
): ManagedAuthorityLoss => ({
  launchConnectionId: createUuidV7(),
  connectionId: createUuidV7(),
  label,
  reason,
});

describe("managedAuthorityLostError", () => {
  concurrentTest(
    "is the run's named error, with the first loss's reason",
    () => {
      const error = managedAuthorityLostError([loss("Notion", "replaced")]);
      const named = namedRunError({ status: "failed", errorJson: error });
      expect(named.name).toBe(MANAGED_CONNECTION_AUTHORITY_LOST);
      expect(named.cause).toEqual({ reason: "replaced" });
      expect(isManagedConnectionAuthorityLost(named)).toBe(true);
      expect(
        isManagedConnectionAuthorityLost({ name: "Scarn.StepFailed" }),
      ).toBe(false);
    },
  );

  concurrentTest("names each lost connection's label once", () => {
    expect(managedAuthorityLostError([loss("Notion")]).message).toContain(
      "Notion changes the failed attempt already made may remain",
    );
    expect(
      managedAuthorityLostError([
        loss("Notion"),
        loss("Acme docs"),
        loss("Notion"),
      ]).message,
    ).toContain(
      "Notion and Acme docs changes the failed attempt already made may remain",
    );
  });

  concurrentTest("falls back to generic wording without a label", () => {
    expect(managedAuthorityLostError([loss(null)]).message).toContain(
      "Changes in the connected services the failed attempt already made may remain",
    );
  });
});
