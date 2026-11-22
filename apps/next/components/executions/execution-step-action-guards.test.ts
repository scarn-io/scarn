import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { Next } from "@scarn/sdk/contracts/pipeline-document";
import {
  canOverruleVisit,
  canRerunVisit,
  isAwaitingDecision,
  isAwaitingReply,
  resolveStepMessageGate,
  startVisit,
  type StepMessageGateInput,
} from "./execution-step-action-guards";
import {
  buildLane,
  buildRunExecution,
  buildVisit,
  buildVisitTask,
} from "./execution-detail-view.test-helpers";

const EXECUTION_ID = "019e9a92-b432-73e8-9341-3519156fa696";
const VISIT_ID = "019e9a92-b432-73e8-9341-3519156fa698";
const TASK_ID = "019e9a92-b432-73e8-9341-3519156fa699";
const LANE_ID = "019e9a92-b432-73e8-9341-3519156fa720";
const LANE_GROUP_ID = "019e9a92-b432-73e8-9341-3519156fa721";
const CURRENT_HREF = "/tester/demo/runs/run-1?step=fix";

const fixVisit = (overrides: Partial<Parameters<typeof buildVisit>[0]> = {}) =>
  buildVisit({
    id: VISIT_ID,
    nodeId: "fix",
    tasks: [buildVisitTask({ taskId: TASK_ID })],
    ...overrides,
  });

const execution = buildRunExecution({ id: EXECUTION_ID });

const CONVERSATION_ID = "019e9a92-b432-73e8-9341-3519156fa740";

/** A step visit whose agent handed the conversation over to a person. */
const waitingVisit = () =>
  fixVisit({
    status: "waiting",
    tasks: [buildVisitTask({ taskId: TASK_ID, status: "yielded" })],
    conversationId: parseUuidV7(CONVERSATION_ID),
  });

const buildInput = (
  overrides: Partial<StepMessageGateInput> = {},
): StepMessageGateInput => ({
  canWriteExecutions: true,
  execution,
  visit: fixVisit(),
  nodeKind: "step",
  taskKind: "agent",
  currentVisitHref: CURRENT_HREF,
  isMutating: false,
  ...overrides,
});

const inFailedLaneGroup = () =>
  buildRunExecution({
    id: EXECUTION_ID,
    laneGroups: [
      {
        id: parseUuidV7(LANE_GROUP_ID),
        parentLaneId: null,
        spawnedByVisitId: parseUuidV7(VISIT_ID),
        kind: "each",
        laneCount: 1,
        maxConcurrency: null,
        toleratedFailures: { count: 0 },
        status: "failed",
      },
    ],
    lanes: [
      buildLane({
        id: LANE_ID,
        laneGroupId: LANE_GROUP_ID,
        status: "failed",
      }),
    ],
  });

describe("canRerunVisit", () => {
  test("allows step and wait visits of a live or finished run", () => {
    expect(canRerunVisit(execution, fixVisit())).toBe(true);
    expect(
      canRerunVisit(
        execution,
        fixVisit({ nodeKind: "wait", status: "waiting", tasks: [] }),
      ),
    ).toBe(true);
  });

  test("refuses terminal nodes, superseded visits, cancelled runs and failed lane groups", () => {
    expect(canRerunVisit(execution, null)).toBe(false);
    expect(canRerunVisit(execution, fixVisit({ nodeKind: "succeed" }))).toBe(
      false,
    );
    expect(canRerunVisit(execution, fixVisit({ status: "superseded" }))).toBe(
      false,
    );
    expect(
      canRerunVisit(
        buildRunExecution({ id: EXECUTION_ID, status: "cancelled" }),
        fixVisit(),
      ),
    ).toBe(false);
    expect(
      canRerunVisit(
        inFailedLaneGroup(),
        fixVisit({ laneId: parseUuidV7(LANE_ID) }),
      ),
    ).toBe(false);
  });
});

describe("canOverruleVisit", () => {
  const when = { path: "result.ok", op: "equal" as const, value: true };
  const judgementCall: Next = {
    routes: [{ when, to: "ship" }],
    otherwise: { to: "fix" },
    overridable: true,
  };
  const routedVisit = (
    taken: { kind: "route" | "otherwise"; index: number }[],
  ) => fixVisit({ routing: { checked: [], taken, overrules: [] } });

  test("allows a succeeded step visit whose taken route and another are overridable", () => {
    expect(
      canOverruleVisit(
        execution,
        routedVisit([{ kind: "route", index: 0 }]),
        judgementCall,
      ),
    ).toBe(true);
  });

  test("refuses when the taken route isn't overridable, nothing is, or the visit can't be overruled", () => {
    const lockedTaken: Next = {
      routes: [{ when, to: "ship" }],
      otherwise: { to: "fix", overridable: true },
    };
    expect(
      canOverruleVisit(
        execution,
        routedVisit([{ kind: "route", index: 0 }]),
        lockedTaken,
      ),
    ).toBe(false);
    expect(
      canOverruleVisit(execution, routedVisit([{ kind: "route", index: 0 }]), {
        routes: [{ when, to: "ship" }],
        otherwise: { to: "fix" },
      }),
    ).toBe(false);
    expect(
      canOverruleVisit(
        execution,
        fixVisit({
          status: "failed",
          routing: { checked: [], taken: null, overrules: [] },
        }),
        judgementCall,
      ),
    ).toBe(false);
    expect(canOverruleVisit(execution, fixVisit(), judgementCall)).toBe(false);
  });

  test("under match all, needs only one overridable conditional route", () => {
    const fanOut: Next = {
      match: "all",
      routes: [{ to: "log" }, { when, to: "ship", overridable: true }],
    };
    expect(
      canOverruleVisit(
        execution,
        routedVisit([{ kind: "route", index: 0 }]),
        fanOut,
      ),
    ).toBe(true);
  });
});

describe("startVisit", () => {
  test("finds the run's current start visit", () => {
    const superseded = fixVisit({
      id: "019e9a92-b432-73e8-9341-3519156fa730",
      status: "superseded",
    });
    const current = fixVisit();
    expect(startVisit({ visits: [superseded, current] })?.id).toBe(
      parseUuidV7(VISIT_ID),
    );
  });
});

describe("isAwaitingDecision", () => {
  test("only a waiting decision wait visit can be decided", () => {
    expect(
      isAwaitingDecision({
        nodeKind: "wait",
        status: "waiting",
        waitFor: "decision",
      }),
    ).toBe(true);
    expect(
      isAwaitingDecision({
        nodeKind: "wait",
        status: "succeeded",
        waitFor: "decision",
      }),
    ).toBe(false);
    expect(
      isAwaitingDecision({
        nodeKind: "wait",
        status: "waiting",
        waitFor: "reply",
      }),
    ).toBe(false);
    expect(isAwaitingDecision(null)).toBe(false);
  });

  test("a decision wait doesn't await a reply", () => {
    const decision = {
      nodeKind: "wait" as const,
      status: "waiting" as const,
      waitFor: "decision" as const,
    };
    expect(isAwaitingReply(decision)).toBe(false);
  });
});

describe("isAwaitingReply", () => {
  test("only a waiting reply wait visit awaits a reply", () => {
    expect(
      isAwaitingReply({
        nodeKind: "wait",
        status: "waiting",
        waitFor: "reply",
      }),
    ).toBe(true);
    expect(
      isAwaitingReply({
        nodeKind: "wait",
        status: "waiting",
        waitFor: "decision",
      }),
    ).toBe(false);
    expect(
      isAwaitingReply({
        nodeKind: "wait",
        status: "succeeded",
        waitFor: "reply",
      }),
    ).toBe(false);
    expect(isAwaitingReply(null)).toBe(false);
  });
});

describe("resolveStepMessageGate", () => {
  test("is ready on a finished agent step visit", () => {
    expect(resolveStepMessageGate(buildInput())).toEqual({ kind: "ready" });
  });

  test("is hidden without executions:write", () => {
    expect(
      resolveStepMessageGate(buildInput({ canWriteExecutions: false })),
    ).toEqual({ kind: "hidden" });
  });

  test("is hidden for wait nodes, visited or not", () => {
    expect(
      resolveStepMessageGate(
        buildInput({ visit: fixVisit({ nodeKind: "wait" }), nodeKind: "wait" }),
      ),
    ).toEqual({ kind: "hidden" });
    expect(
      resolveStepMessageGate(buildInput({ visit: null, nodeKind: "wait" })),
    ).toEqual({ kind: "hidden" });
  });

  test("is hidden for a code or MCP tool step and while the task kind loads", () => {
    expect(
      resolveStepMessageGate(buildInput({ taskKind: "mcp_tool" })),
    ).toEqual({ kind: "hidden" });
    expect(resolveStepMessageGate(buildInput({ taskKind: "code" }))).toEqual({
      kind: "hidden",
    });
    expect(resolveStepMessageGate(buildInput({ taskKind: null }))).toEqual({
      kind: "hidden",
    });
  });

  test("is disabled when the step hasn't run yet", () => {
    expect(
      resolveStepMessageGate(buildInput({ visit: null, taskKind: null })),
    ).toEqual({ kind: "disabled", reason: "This step hasn't run yet" });
  });

  test("is disabled on a superseded visit, linking the current one", () => {
    expect(
      resolveStepMessageGate(
        buildInput({ visit: fixVisit({ status: "superseded" }) }),
      ),
    ).toEqual({
      kind: "disabled",
      reason: "A later rerun replaced this visit",
      latestHref: CURRENT_HREF,
    });
  });

  test("is disabled when the visit can't be rerun", () => {
    expect(
      resolveStepMessageGate(
        buildInput({
          execution: buildRunExecution({
            id: EXECUTION_ID,
            status: "cancelled",
          }),
        }),
      ),
    ).toEqual({ kind: "disabled", reason: "This visit can't be rerun" });
  });

  test.each(["queued", "running"] as const)(
    "is disabled while the visit's task is %s",
    (status) => {
      const visit = fixVisit({
        status: "active",
        tasks: [buildVisitTask({ taskId: TASK_ID, status })],
      });
      expect(resolveStepMessageGate(buildInput({ visit }))).toEqual({
        kind: "disabled",
        reason: "Waiting for this step to finish",
      });
    },
  );

  test("is ready on an active visit whose task was abandoned", () => {
    const visit = fixVisit({
      status: "active",
      tasks: [buildVisitTask({ taskId: TASK_ID, status: "abandoned" })],
    });
    expect(resolveStepMessageGate(buildInput({ visit }))).toEqual({
      kind: "ready",
    });
  });

  test("is disabled while a mutation is in flight", () => {
    expect(resolveStepMessageGate(buildInput({ isMutating: true }))).toEqual({
      kind: "disabled",
      reason: "Waiting for the current action to finish",
    });
  });

  test("is ready on a step visit waiting on a person (Rerun with message)", () => {
    expect(
      resolveStepMessageGate(buildInput({ visit: waitingVisit() })),
    ).toEqual({ kind: "ready" });
  });
});
