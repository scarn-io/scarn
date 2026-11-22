import { signLogFeedToken } from "@scarn/core/tasks/task-log/domain/log-feed-token";
import { signWorkSignalToken } from "@scarn/core/tasks/task-run/domain/work-signal-token";
import { describe, expect, it } from "vitest";
import { verifyLogFeedToken } from "../src/log-feed-token";
import { verifyWorkSignalToken } from "../src/token";
import { nowSeconds, signToken } from "./helpers";

const SECRET = "test-log-feed-secret";
const TASK_RUN_ID = "task-run-1";

function claims(
  overrides: Partial<Parameters<typeof signLogFeedToken>[0]> = {},
) {
  return {
    tid: TASK_RUN_ID,
    pid: "project-1",
    scope: "write" as const,
    exp: nowSeconds() + 900,
    oid: "org-1",
    ...overrides,
  };
}

describe("verifyLogFeedToken", () => {
  it("accepts a write token signed by core for the same task run", async () => {
    const issued = claims();
    const token = await signLogFeedToken(issued, SECRET);

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "write",
      }),
    ).resolves.toEqual(issued);
  });

  it("accepts a read token signed by core for the same task run", async () => {
    const issued = claims({ scope: "read" });
    const token = await signLogFeedToken(issued, SECRET);

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "read",
      }),
    ).resolves.toEqual(issued);
  });

  it("rejects an expired token", async () => {
    const token = await signLogFeedToken(
      claims({ exp: nowSeconds() - 1 }),
      SECRET,
    );

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "write",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a read token where write is required", async () => {
    const token = await signLogFeedToken(claims({ scope: "read" }), SECRET);

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "write",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a write token where read is required", async () => {
    const token = await signLogFeedToken(claims({ scope: "write" }), SECRET);

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "read",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a token issued for a different task run", async () => {
    const token = await signLogFeedToken(claims({ tid: "task-run-2" }), SECRET);

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "write",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signLogFeedToken(claims(), "other-secret");

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "write",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a write token without an org id", async () => {
    const token = await signToken(
      {
        tid: TASK_RUN_ID,
        pid: "project-1",
        scope: "write",
        exp: nowSeconds() + 900,
      },
      SECRET,
    );

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "write",
      }),
    ).resolves.toBeNull();
  });

  it("accepts a read token without an org id", async () => {
    const issued = {
      tid: TASK_RUN_ID,
      pid: "project-1",
      scope: "read",
      exp: nowSeconds() + 900,
    };
    const token = await signToken(issued, SECRET);

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "read",
      }),
    ).resolves.toEqual(issued);
  });

  it.each([
    ["a non-string", 42],
    ["an empty", ""],
  ])("rejects a token with %s org id", async (_label, oid) => {
    const token = await signToken({ ...claims(), oid }, SECRET);

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "write",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a work-signal token even when signed with the same secret", async () => {
    const issued = {
      pid: "project-1",
      sub: "worker-1",
      oid: "org-1",
      exp: nowSeconds() + 900,
    };
    const token = await signWorkSignalToken(issued, SECRET);

    await expect(
      verifyLogFeedToken(token, SECRET, {
        taskRunId: TASK_RUN_ID,
        scope: "write",
      }),
    ).resolves.toBeNull();
  });
});

describe("verifyWorkSignalToken", () => {
  it("accepts a work-signal token signed by core", async () => {
    const issued = {
      pid: "project-1",
      sub: "worker-1",
      oid: "org-1",
      exp: nowSeconds() + 900,
    };
    const token = await signWorkSignalToken(issued, SECRET);

    await expect(verifyWorkSignalToken(token, SECRET)).resolves.toEqual(issued);
  });

  it("rejects a token without an org id", async () => {
    const token = await signToken(
      { pid: "project-1", sub: "worker-1", exp: nowSeconds() + 900 },
      SECRET,
    );

    await expect(verifyWorkSignalToken(token, SECRET)).resolves.toBeNull();
  });

  it.each([
    ["a non-string", 42],
    ["an empty", ""],
  ])("rejects a token with %s org id", async (_label, oid) => {
    const token = await signToken(
      { pid: "project-1", sub: "worker-1", exp: nowSeconds() + 900, oid },
      SECRET,
    );

    await expect(verifyWorkSignalToken(token, SECRET)).resolves.toBeNull();
  });

  it("rejects a log-feed token even when signed with the same secret", async () => {
    const token = await signLogFeedToken(claims(), SECRET);

    await expect(verifyWorkSignalToken(token, SECRET)).resolves.toBeNull();
  });
});
