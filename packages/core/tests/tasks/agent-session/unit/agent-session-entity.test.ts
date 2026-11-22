import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { CoreValidationError } from "@/lib/errors";
import {
  AgentSessionEntity,
  type AgentSessionEntityProps,
  type CreateRootAgentSessionProps,
} from "@/tasks/agent-session/domain/agent-session-entity";
import { concurrentTest } from "tests/utils";

const STARTED_AT = new Date("2026-10-13T12:00:00.000Z");
const ENDED_AT = new Date("2026-10-13T12:05:00.000Z");

const rootProps = (): CreateRootAgentSessionProps => ({
  taskRunId: createUuidV7(),
  provider: "opencode",
  externalSessionId: `ses_${crypto.randomUUID()}`,
  startedAt: STARTED_AT,
});

const rehydrateProps = (): AgentSessionEntityProps => {
  const id = createUuidV7();
  return {
    ...rootProps(),
    id,
    conversationRootId: id,
    status: "running",
  };
};

const codeOf = (create: () => object) => {
  try {
    create();
  } catch (error) {
    return (error as CoreValidationError).code;
  }
  return null;
};

describe("agent session entity", () => {
  concurrentTest("a root session is its own running conversation root", () => {
    const session = AgentSessionEntity.createRoot(rootProps());

    expect(session.conversationRootId).toBe(session.id);
    expect(session.toJSON()).toMatchObject({
      parentAgentSessionId: null,
      provider: "opencode",
      status: "running",
      startedAt: STARTED_AT,
      endedAt: null,
    });
  });

  concurrentTest("a continuation points at the conversation root", () => {
    const root = AgentSessionEntity.createRoot(rootProps());

    const continuation = AgentSessionEntity.createContinuation({
      ...rootProps(),
      conversationRootId: root.id,
    });

    expect(continuation.id).not.toBe(root.id);
    expect(continuation.conversationRootId).toBe(root.id);
    expect(continuation.status).toBe("running");
  });

  concurrentTest("a continuation cannot be its own root", () => {
    const id = createUuidV7();

    expect(
      codeOf(() =>
        AgentSessionEntity.createContinuation({
          ...rootProps(),
          id,
          conversationRootId: id,
        }),
      ),
    ).toBe("AGENT_SESSION_CONVERSATION_ROOT_INVALID");
  });

  concurrentTest("records a subagent's parent session", () => {
    const parent = AgentSessionEntity.createRoot(rootProps());

    const subagent = AgentSessionEntity.createRoot({
      ...rootProps(),
      parentAgentSessionId: parent.id,
    });

    expect(subagent.parentAgentSessionId).toBe(parent.id);
  });

  concurrentTest("rejects a session that is its own parent", () => {
    const id = createUuidV7();

    expect(
      codeOf(() =>
        AgentSessionEntity.createRoot({
          ...rootProps(),
          id,
          parentAgentSessionId: id,
        }),
      ),
    ).toBe("AGENT_SESSION_PARENT_INVALID");
  });

  concurrentTest("end() and fail() set endedAt", () => {
    const session = AgentSessionEntity.createRoot(rootProps());

    const ended = session.end(ENDED_AT);
    const failed = session.fail(ENDED_AT);

    expect(ended.status).toBe("ended");
    expect(ended.endedAt).toEqual(ENDED_AT);
    expect(failed.status).toBe("failed");
    expect(failed.endedAt).toEqual(ENDED_AT);
    expect(session.status).toBe("running");
    expect(session.endedAt).toBeNull();
  });

  concurrentTest("a finished session cannot end or fail again", () => {
    const ended = AgentSessionEntity.createRoot(rootProps()).end(ENDED_AT);

    expect(codeOf(() => ended.end(ENDED_AT))).toBe("AGENT_SESSION_NOT_RUNNING");
    expect(codeOf(() => ended.fail(ENDED_AT))).toBe(
      "AGENT_SESSION_NOT_RUNNING",
    );
  });

  concurrentTest("rejects an endedAt before startedAt", () => {
    const session = AgentSessionEntity.createRoot(rootProps());

    expect(
      codeOf(() => session.end(new Date("2026-10-13T11:59:59.000Z"))),
    ).toBe("AGENT_SESSION_ENDED_AT_BEFORE_STARTED_AT");
  });

  concurrentTest("status and endedAt must agree", () => {
    expect(
      codeOf(() =>
        AgentSessionEntity.rehydrate({
          ...rehydrateProps(),
          endedAt: ENDED_AT,
        }),
      ),
    ).toBe("AGENT_SESSION_ENDED_AT_MISMATCH");
    expect(
      codeOf(() =>
        AgentSessionEntity.rehydrate({ ...rehydrateProps(), status: "ended" }),
      ),
    ).toBe("AGENT_SESSION_ENDED_AT_MISMATCH");
  });

  concurrentTest("rehydrates a session whose root was deleted", () => {
    const session = AgentSessionEntity.rehydrate({
      ...rehydrateProps(),
      conversationRootId: null,
    });

    expect(session.conversationRootId).toBeNull();
  });

  concurrentTest("rejects an empty provider or external session id", () => {
    expect(
      codeOf(() =>
        AgentSessionEntity.createRoot({ ...rootProps(), provider: " " }),
      ),
    ).toBe("AGENT_SESSION_PROVIDER_REQUIRED");
    expect(
      codeOf(() =>
        AgentSessionEntity.createRoot({
          ...rootProps(),
          externalSessionId: "",
        }),
      ),
    ).toBe("AGENT_SESSION_EXTERNAL_SESSION_ID_REQUIRED");
  });
});
