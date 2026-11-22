import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedConnectionEntity,
  type ManagedConnectionEntity as ManagedConnection,
  type ServingManagedConnectionEntity,
} from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import {
  launchClaimTokenDigest,
  mcpSessionIdDigest,
  randomRelayCapability,
  relayCapabilityDigest,
} from "@/connections/managed-mcp-connection/domain/managed-launch-digests";
import {
  createManagedOperation,
  ManagedLaunchConnectionEntity,
} from "@/connections/managed-mcp-connection/domain/managed-launch-connection-entity";
import { InvariantViolationError, type CoreError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";
import { managedConnectionDefinitionFromPreset } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";

const NOTION_CONNECTION = managedConnectionDefinitionFromPreset("notion");

const T0 = new Date("2026-11-18T10:00:00.000Z");
const T1 = new Date("2026-11-18T10:01:00.000Z");
const T2 = new Date("2026-11-18T10:02:00.000Z");
const projectId = createUuidV7();
const alice = createUuidV7();
const FINGERPRINT = "fingerprint-a";

const confirmInput = (now: Date) => ({
  candidateFingerprint: FINGERPRINT,
  confirmedByUserId: alice,
  now,
});

const ready = (activeId: UuidV7 = createUuidV7()) =>
  ManagedConnectionEntity.create({ ...NOTION_CONNECTION, projectId, now: T0 })
    .startConnect(T0)
    .attachCandidate(activeId, T0)
    .confirmCandidate(activeId, FINGERPRINT, confirmInput(T0));

const asServing = (
  connection: ManagedConnection,
): ServingManagedConnectionEntity => {
  if (
    connection.state !== "ready" &&
    connection.state !== "ready_with_pending_reconnect"
  ) {
    throw new Error(`Expected a serving connection, got ${connection.state}`);
  }
  return connection;
};

const launchFor = (connection: ServingManagedConnectionEntity) =>
  ManagedLaunchConnectionEntity.create({
    projectId,
    taskRunId: createUuidV7(),
    claimTokenDigest: launchClaimTokenDigest("claim-token"),
    entryKey: "notion",
    connection,
    capabilityDigest: relayCapabilityDigest(randomRelayCapability()),
    now: T0,
  });

/**
 * One connection in each of the six states, all at the launch's generation,
 * so only the state decides. States a serving connection can't reach without
 * a generation bump are rehydrated directly.
 */
const connectionInEachState = () => {
  const base = asServing(ready());
  const launch = launchFor(base);
  const candidateId = createUuidV7();
  return {
    launch,
    states: {
      ready: base,
      ready_with_pending_reconnect: base
        .startReconnect(T1)
        .attachCandidate(candidateId, T1),
      reconnect_required: base.requireReconnect("refresh_failed", T1),
      connecting: ManagedConnectionEntity.rehydrate({
        ...base.toJSON(),
        state: "connecting",
        activeGrantId: null,
        connectedByUserId: null,
      }),
      awaiting_confirmation: ManagedConnectionEntity.rehydrate({
        ...base.toJSON(),
        state: "awaiting_confirmation",
        activeGrantId: null,
        connectedByUserId: null,
        candidateGrantId: candidateId,
      }),
      disconnected: ManagedConnectionEntity.rehydrate({
        ...base.toJSON(),
        state: "disconnected",
        activeGrantId: null,
        connectedByUserId: null,
      }),
    } satisfies Record<ManagedConnection["state"], ManagedConnection>,
  };
};

describe("ManagedLaunchConnectionEntity.create", () => {
  concurrentTest(
    "pins the serving connection's generation and grant, open with no session",
    () => {
      const connection = asServing(ready());
      const launch = launchFor(connection);
      expect(launch.connectionId).toBe(connection.id);
      expect(launch.generation).toBe(connection.generation);
      expect(launch.grantId).toBe(connection.activeGrantId);
      expect(launch.state).toBe("open");
      expect(launch.mcpSessionIdDigest).toBeNull();
      expect(launch.closedAt).toBeNull();
    },
  );
});

describe("ManagedLaunchConnectionEntity.isAuthorizedBy", () => {
  concurrentTest("only the two serving states authorize a launch", () => {
    const { launch, states } = connectionInEachState();
    const authorized = Object.fromEntries(
      Object.entries(states).map(([state, connection]) => [
        state,
        launch.isAuthorizedBy(connection),
      ]),
    );
    expect(authorized).toEqual({
      ready: true,
      ready_with_pending_reconnect: true,
      reconnect_required: false,
      connecting: false,
      awaiting_confirmation: false,
      disconnected: false,
    });
  });

  concurrentTest("names the reason for each non-serving state", () => {
    const { launch, states } = connectionInEachState();
    expect(launch.authorityLossReason(states.reconnect_required)).toBe(
      "reconnect_required",
    );
    expect(launch.authorityLossReason(states.connecting)).toBe(
      "reconnect_required",
    );
    expect(launch.authorityLossReason(states.awaiting_confirmation)).toBe(
      "reconnect_required",
    );
    expect(launch.authorityLossReason(states.disconnected)).toBe(
      "disconnected",
    );
  });

  concurrentTest(
    "a generation bump fails it even while the grant still matches",
    () => {
      const connection = asServing(ready());
      const launch = launchFor(connection);
      const bumped = ManagedConnectionEntity.rehydrate({
        ...connection.toJSON(),
        generation: connection.generation + 1,
      });
      expect(launch.isAuthorizedBy(bumped)).toBe(false);
      expect(launch.authorityLossReason(bumped)).toBe("replaced");
    },
  );

  concurrentTest("a disconnect bumps the generation and fails it", () => {
    const connection = asServing(ready());
    const launch = launchFor(connection);
    const disconnected = connection.disconnect(T1);
    expect(disconnected.generation).toBe(connection.generation + 1);
    expect(launch.isAuthorizedBy(disconnected)).toBe(false);
    expect(launch.authorityLossReason(disconnected)).toBe("disconnected");
  });

  concurrentTest("requireReconnect without a generation bump fails it", () => {
    const connection = asServing(ready());
    const launch = launchFor(connection);
    const required = connection.requireReconnect("refresh_failed", T1);
    expect(required.generation).toBe(connection.generation);
    expect(required.toJSON().activeGrantId).toBe(connection.activeGrantId);
    expect(launch.isAuthorizedBy(required)).toBe(false);
    expect(launch.authorityLossReason(required)).toBe("reconnect_required");
  });

  concurrentTest("a confirmed reconnect fails it", () => {
    const connection = asServing(ready());
    const launch = launchFor(connection);
    const candidateId = createUuidV7();
    const replaced = connection
      .startReconnect(T1)
      .attachCandidate(candidateId, T1)
      .confirmCandidate(candidateId, FINGERPRINT, confirmInput(T2));
    expect(replaced.state).toBe("ready");
    expect(replaced.servingGrantId).toBe(candidateId);
    expect(launch.isAuthorizedBy(replaced)).toBe(false);
    expect(launch.authorityLossReason(replaced)).toBe("replaced");
  });

  concurrentTest(
    "a different serving grant at the same generation fails it",
    () => {
      const connection = asServing(ready());
      const launch = launchFor(connection);
      const swapped = ManagedConnectionEntity.rehydrate({
        ...connection.toJSON(),
        activeGrantId: createUuidV7(),
      });
      expect(launch.isAuthorizedBy(swapped)).toBe(false);
      expect(launch.authorityLossReason(swapped)).toBe("replaced");
    },
  );

  concurrentTest(
    "a pending reconnect that is cancelled keeps the launch authorized",
    () => {
      const connection = asServing(ready());
      const launch = launchFor(connection);
      const candidateId = createUuidV7();
      const cancelled = connection
        .startReconnect(T1)
        .attachCandidate(candidateId, T1)
        .cancelCandidate(candidateId, T2);
      expect(launch.isAuthorizedBy(cancelled)).toBe(true);
    },
  );

  concurrentTest("a closed launch is never authorized", () => {
    const connection = asServing(ready());
    const launch = launchFor(connection).close(T1);
    expect(launch.isAuthorizedBy(connection)).toBe(false);
    expect(launch.authorityLossReason(connection)).toBeNull();
  });

  concurrentTest("checking against another connection is a bug", () => {
    const launch = launchFor(asServing(ready()));
    expect(() => launch.isAuthorizedBy(ready())).toThrow(
      InvariantViolationError,
    );
  });
});

describe("ManagedLaunchConnectionEntity lifecycle", () => {
  concurrentTest("close records the time once and is idempotent", () => {
    const closed = launchFor(asServing(ready())).close(T1);
    expect(closed.state).toBe("closed");
    expect(closed.closedAt).toEqual(T1);
    expect(closed.close(T2).closedAt).toEqual(T1);
  });

  concurrentTest("bindSession replaces an earlier session", () => {
    const second = mcpSessionIdDigest("session-2");
    const bound = launchFor(asServing(ready()))
      .bindSession(mcpSessionIdDigest("session-1"))
      .bindSession(second);
    expect(bound.mcpSessionIdDigest).toEqual(second);
  });

  concurrentTest("bindSession on a closed launch is a conflict", () => {
    const closed = launchFor(asServing(ready())).close(T1);
    try {
      closed.bindSession(mcpSessionIdDigest("session-1"));
    } catch (error) {
      expect((error as CoreError).code).toBe("MANAGED_LAUNCH_CLOSED");
      return;
    }
    throw new Error("Expected MANAGED_LAUNCH_CLOSED");
  });

  concurrentTest("rehydrate rejects a closed row without closedAt", () => {
    const launch = launchFor(asServing(ready()));
    expect(() =>
      ManagedLaunchConnectionEntity.rehydrate({
        ...launch.toJSON(),
        state: "closed",
      }),
    ).toThrow();
  });
});

describe("launch digests and operations", () => {
  concurrentTest("digests are 32 bytes and separated by role", () => {
    const value = randomRelayCapability();
    expect(value).toHaveLength(43);
    expect(relayCapabilityDigest(value)).toHaveLength(32);
    expect(relayCapabilityDigest(value)).toEqual(relayCapabilityDigest(value));
    expect(relayCapabilityDigest(value)).not.toEqual(
      launchClaimTokenDigest(value),
    );
    expect(relayCapabilityDigest(value)).not.toEqual(mcpSessionIdDigest(value));
  });

  concurrentTest("an operation's deadline must follow its start", () => {
    expect(() =>
      createManagedOperation({
        launchConnectionId: createUuidV7(),
        startedAt: T1,
        deadlineAt: T1,
      }),
    ).toThrow();
  });
});
