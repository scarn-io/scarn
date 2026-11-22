import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedConnectionEntity,
  type ManagedConnectionRowProps,
} from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import { CoreError, CoreValidationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";
import { managedConnectionDefinitionFromPreset } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";

const NOTION_CONNECTION = managedConnectionDefinitionFromPreset("notion");

const T0 = new Date("2026-11-17T10:00:00.000Z");
const T1 = new Date("2026-11-17T10:01:00.000Z");
const projectId = createUuidV7();
const alice = createUuidV7();
const bob = createUuidV7();
const FINGERPRINT = "fingerprint-a";

const newConnection = () =>
  ManagedConnectionEntity.create({ ...NOTION_CONNECTION, projectId, now: T0 });

const confirmInput = (confirmedByUserId: UuidV7 = alice) => ({
  candidateFingerprint: FINGERPRINT,
  confirmedByUserId,
  now: T1,
});

const awaitingConfirmation = (candidateId: UuidV7) =>
  newConnection().startConnect(T0).attachCandidate(candidateId, T0);

const ready = (activeId: UuidV7) =>
  awaitingConfirmation(activeId).confirmCandidate(
    activeId,
    FINGERPRINT,
    confirmInput(),
  );

const expectStateConflict = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("MANAGED_CONNECTION_STATE_CONFLICT");
    expect((error as CoreError).status).toBe(409);
    return;
  }
  throw new Error("Expected a state conflict");
};

const expectCandidateMismatch = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect((error as CoreError).code).toBe(
      "MANAGED_CONNECTION_CANDIDATE_MISMATCH",
    );
    return;
  }
  throw new Error("Expected a candidate mismatch");
};

describe("ManagedConnectionEntity first connect", () => {
  concurrentTest("starts disconnected at generation and version 0", () => {
    const connection = newConnection();
    expect(connection.state).toBe("disconnected");
    expect(connection.generation).toBe(0);
    expect(connection.version).toBe(0);
  });

  concurrentTest(
    "connect, attach and confirm reach ready without bumping generation",
    () => {
      const candidateId = createUuidV7();
      const connecting = newConnection().startConnect(T0);
      expect(connecting.state).toBe("connecting");
      expect(connecting.version).toBe(1);

      const awaiting = connecting.attachCandidate(candidateId, T0);
      expect(awaiting.state).toBe("awaiting_confirmation");
      expect(awaiting.pendingCandidateGrantId).toBe(candidateId);
      expect(awaiting.servingGrantId).toBeNull();

      const confirmed = awaiting.confirmCandidate(
        candidateId,
        FINGERPRINT,
        confirmInput(),
      );
      expect(confirmed.state).toBe("ready");
      expect(confirmed.servingGrantId).toBe(candidateId);
      expect(confirmed.version).toBe(3);
      expect(confirmed.generation).toBe(0);
      expect(confirmed.updatedAt).toEqual(T1);
      expect(confirmed.toJSON().connectedByUserId).toBe(alice);
    },
  );

  concurrentTest("rejects a different candidate ID or fingerprint", () => {
    const candidateId = createUuidV7();
    const awaiting = awaitingConfirmation(candidateId);
    expectCandidateMismatch(() =>
      awaiting.confirmCandidate(createUuidV7(), FINGERPRINT, confirmInput()),
    );
    expectCandidateMismatch(() =>
      awaiting.confirmCandidate(candidateId, "fingerprint-b", confirmInput()),
    );
  });

  concurrentTest("cancelling a first candidate disconnects", () => {
    const candidateId = createUuidV7();
    const cancelled = awaitingConfirmation(candidateId).cancelCandidate(
      candidateId,
      T1,
    );
    expect(cancelled.state).toBe("disconnected");
    expect(cancelled.toJSON().reasonCode).toBe("candidate_cancelled");
    expect(cancelled.generation).toBe(0);
  });

  concurrentTest("expiring an attempt or a candidate disconnects", () => {
    const fromAttempt = newConnection().startConnect(T0).expire(T1);
    expect(fromAttempt.state).toBe("disconnected");
    expect(fromAttempt.toJSON().reasonCode).toBe("attempt_expired");

    const fromCandidate = awaitingConfirmation(createUuidV7()).expire(T1);
    expect(fromCandidate.state).toBe("disconnected");
    expect(fromCandidate.toJSON().reasonCode).toBe("candidate_expired");
  });

  concurrentTest("a disconnected tombstone can connect again", () => {
    const again = ready(createUuidV7()).disconnect(T1).startConnect(T1);
    expect(again.state).toBe("connecting");
  });
});

describe("ManagedConnectionEntity reconnect", () => {
  concurrentTest(
    "keeps the active grant serving while a candidate waits",
    () => {
      const activeId = createUuidV7();
      const candidateId = createUuidV7();
      const pending = ready(activeId)
        .startReconnect(T1)
        .attachCandidate(candidateId, T1);
      expect(pending.state).toBe("ready_with_pending_reconnect");
      expect(pending.servingGrantId).toBe(activeId);
      expect(pending.pendingCandidateGrantId).toBe(candidateId);
      expect(pending.generation).toBe(0);
    },
  );

  concurrentTest("confirming swaps the grants and bumps generation", () => {
    const activeId = createUuidV7();
    const candidateId = createUuidV7();
    const pending = ready(activeId).attachCandidate(candidateId, T1);
    const swapped = pending.confirmCandidate(
      candidateId,
      FINGERPRINT,
      confirmInput(bob),
    );
    expect(swapped.state).toBe("ready");
    expect(swapped.servingGrantId).toBe(candidateId);
    expect(swapped.generation).toBe(pending.generation + 1);
    expect(swapped.version).toBe(pending.version + 1);
    expect(swapped.toJSON().connectedByUserId).toBe(bob);
  });

  concurrentTest(
    "cancelling or expiring the candidate leaves the active grant",
    () => {
      const activeId = createUuidV7();
      const candidateId = createUuidV7();
      const pending = ready(activeId).attachCandidate(candidateId, T1);
      for (const next of [
        pending.cancelCandidate(candidateId, T1),
        pending.expire(T1),
      ]) {
        expect(next.state).toBe("ready");
        expect(next.servingGrantId).toBe(activeId);
        expect(next.generation).toBe(pending.generation);
        expect(next.version).toBe(pending.version + 1);
      }
    },
  );

  concurrentTest(
    "reconnect_required waits for a candidate and confirming replaces the grant",
    () => {
      const activeId = createUuidV7();
      const candidateId = createUuidV7();
      const required = ready(activeId).requireReconnect("refresh_failed", T1);
      expect(required.state).toBe("reconnect_required");
      expect(required.servingGrantId).toBeNull();
      expect(required.toJSON().activeGrantId).toBe(activeId);

      const withCandidate = required
        .startReconnect(T1)
        .attachCandidate(candidateId, T1);
      expect(withCandidate.state).toBe("reconnect_required");
      expect(withCandidate.pendingCandidateGrantId).toBe(candidateId);

      const confirmed = withCandidate.confirmCandidate(
        candidateId,
        FINGERPRINT,
        confirmInput(),
      );
      expect(confirmed.state).toBe("ready");
      expect(confirmed.servingGrantId).toBe(candidateId);
      expect(confirmed.generation).toBe(required.generation + 1);
    },
  );
});

describe("ManagedConnectionEntity disconnect", () => {
  concurrentTest("bumps generation from every connected state", () => {
    const activeId = createUuidV7();
    const candidateId = createUuidV7();
    const states = [
      newConnection().startConnect(T0),
      awaitingConfirmation(candidateId),
      ready(activeId),
      ready(activeId).attachCandidate(candidateId, T1),
      ready(activeId).requireReconnect("refresh_failed", T1),
    ];
    for (const connection of states) {
      const disconnected = connection.disconnect(T1);
      expect(disconnected.state).toBe("disconnected");
      expect(disconnected.generation).toBe(connection.generation + 1);
      expect(disconnected.version).toBe(connection.version + 1);
      expect(disconnected.servingGrantId).toBeNull();
      expect(disconnected.pendingCandidateGrantId).toBeNull();
    }
  });
});

describe("ManagedConnectionEntity illegal transitions", () => {
  const candidateId = createUuidV7();
  const activeId = createUuidV7();

  concurrentTest("disconnected", () => {
    const connection = newConnection();
    expectStateConflict(() => connection.startReconnect(T1));
    expectStateConflict(() => connection.attachCandidate(candidateId, T1));
    expectStateConflict(() =>
      connection.confirmCandidate(candidateId, FINGERPRINT, confirmInput()),
    );
    expectStateConflict(() => connection.cancelCandidate(candidateId, T1));
    expectStateConflict(() => connection.expire(T1));
    expectStateConflict(() => connection.disconnect(T1));
  });

  concurrentTest("connecting", () => {
    const connection = newConnection().startConnect(T0);
    expectStateConflict(() => connection.startReconnect(T1));
    expectStateConflict(() =>
      connection.confirmCandidate(candidateId, FINGERPRINT, confirmInput()),
    );
    expectStateConflict(() => connection.cancelCandidate(candidateId, T1));
    expectStateConflict(() =>
      connection.requireReconnect("refresh_failed", T1),
    );
  });

  concurrentTest("awaiting_confirmation", () => {
    const connection = awaitingConfirmation(candidateId);
    expectStateConflict(() => connection.startConnect(T1));
    expectStateConflict(() => connection.startReconnect(T1));
    expectStateConflict(() => connection.attachCandidate(createUuidV7(), T1));
  });

  concurrentTest("ready", () => {
    const connection = ready(activeId);
    expectStateConflict(() => connection.startConnect(T1));
    expectStateConflict(() =>
      connection.confirmCandidate(candidateId, FINGERPRINT, confirmInput()),
    );
    expectStateConflict(() => connection.cancelCandidate(candidateId, T1));
    expectStateConflict(() => connection.expire(T1));
  });

  concurrentTest("ready_with_pending_reconnect", () => {
    const connection = ready(activeId).attachCandidate(candidateId, T1);
    expectStateConflict(() => connection.startConnect(T1));
    expectStateConflict(() => connection.startReconnect(T1));
    expectStateConflict(() => connection.attachCandidate(createUuidV7(), T1));
  });

  concurrentTest("reconnect_required", () => {
    const connection = ready(activeId).requireReconnect("refresh_failed", T1);
    expectStateConflict(() => connection.startConnect(T1));
    expectStateConflict(() =>
      connection.confirmCandidate(candidateId, FINGERPRINT, confirmInput()),
    );
    expectStateConflict(() => connection.expire(T1));

    const withCandidate = connection.attachCandidate(candidateId, T1);
    expectStateConflict(() => withCandidate.startReconnect(T1));
    expectStateConflict(() =>
      withCandidate.attachCandidate(createUuidV7(), T1),
    );
  });
});

describe("ManagedConnectionEntity.rehydrate", () => {
  const row = (
    overrides: Partial<ManagedConnectionRowProps>,
  ): ManagedConnectionRowProps => ({
    id: createUuidV7(),
    projectId,
    ...NOTION_CONNECTION,
    state: "disconnected",
    reasonCode: null,
    generation: 0,
    version: 0,
    activeGrantId: null,
    candidateGrantId: null,
    connectedByUserId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

  concurrentTest("round-trips every state through toJSON", () => {
    const activeId = createUuidV7();
    const candidateId = createUuidV7();
    const states = [
      newConnection(),
      newConnection().startConnect(T0),
      awaitingConfirmation(candidateId),
      ready(activeId),
      ready(activeId).attachCandidate(candidateId, T1),
      ready(activeId).requireReconnect("refresh_failed", T1),
    ];
    for (const connection of states) {
      const rehydrated = ManagedConnectionEntity.rehydrate(connection.toJSON());
      expect(rehydrated.state).toBe(connection.state);
      expect(rehydrated.toJSON()).toEqual(connection.toJSON());
    }
  });

  concurrentTest("rejects rows missing what their state requires", () => {
    expect(() =>
      ManagedConnectionEntity.rehydrate(row({ state: "ready" })),
    ).toThrow(CoreValidationError);
    expect(() =>
      ManagedConnectionEntity.rehydrate(
        row({ state: "awaiting_confirmation" }),
      ),
    ).toThrow(CoreValidationError);
  });

  concurrentTest("rejects rows carrying fields their state can't have", () => {
    expect(() =>
      ManagedConnectionEntity.rehydrate(
        row({ state: "connecting", activeGrantId: createUuidV7() }),
      ),
    ).toThrow(CoreValidationError);
    expect(() =>
      ManagedConnectionEntity.rehydrate(
        row({ state: "disconnected", candidateGrantId: createUuidV7() }),
      ),
    ).toThrow(CoreValidationError);
  });
});
