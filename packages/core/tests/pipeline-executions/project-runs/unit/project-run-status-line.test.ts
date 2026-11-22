import { describe, expect, test } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import {
  pipelineRunOutcome,
  pipelineRunStatusLine,
  type PipelineRunLineFacts,
  type ProjectRunVisitFacts,
} from "@/pipeline-executions/project-runs/application/project-run-status-line";

const document = {
  start: { to: "triage" },
  nodes: {
    triage: { kind: "step", step: "triage" },
    review: {
      kind: "wait",
      for: "decision",
      actions: [{ key: "ok", label: "OK" }],
    },
    ask: { kind: "wait", for: "reply" },
    shipped: { kind: "succeed" },
    rejected: { kind: "fail", error: "Rejected" },
    abandoned: { kind: "fail" },
  },
} as unknown as PipelineDocument;

const visit = (
  overrides: Partial<ProjectRunVisitFacts> &
    Pick<ProjectRunVisitFacts, "nodeId">,
): ProjectRunVisitFacts => ({
  nodeKind: "step",
  status: "succeeded",
  error: null,
  taskRunning: false,
  openQuestionBody: null,
  ...overrides,
});

const facts = (
  overrides: Partial<PipelineRunLineFacts> &
    Pick<PipelineRunLineFacts, "status">,
): PipelineRunLineFacts => ({
  visits: [],
  document,
  endNodeId: null,
  error: null,
  ...overrides,
});

describe("pipelineRunStatusLine", () => {
  test("a decision wait on the viewer asks for their decision", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "needs-you",
          visits: [
            visit({ nodeId: "triage" }),
            visit({ nodeId: "review", nodeKind: "wait", status: "waiting" }),
          ],
        }),
      ),
    ).toBe("Waiting for your decision at review");
  });

  test("a decision wait on someone else doesn't say 'your'", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "waiting",
          visits: [
            visit({ nodeId: "review", nodeKind: "wait", status: "waiting" }),
          ],
        }),
      ),
    ).toBe("Waiting for a decision at review");
  });

  test("a wait with an open question shows the question on one line", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "needs-you",
          visits: [
            visit({
              nodeId: "ask",
              nodeKind: "wait",
              status: "waiting",
              openQuestionBody: "Which   browser\nare you on?",
            }),
          ],
        }),
      ),
    ).toBe("Which browser are you on?");
  });

  test("a step handed to a person waits for a reply", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "needs-you",
          visits: [visit({ nodeId: "triage", status: "waiting" })],
        }),
      ),
    ).toBe("Waiting for your reply at triage");
  });

  test("one running step names it", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "running",
          visits: [
            visit({ nodeId: "triage", status: "active", taskRunning: true }),
          ],
        }),
      ),
    ).toBe("Running triage");
  });

  test("several running steps are counted and named", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "running",
          visits: [
            visit({ nodeId: "a", status: "active", taskRunning: true }),
            visit({ nodeId: "b", status: "active", taskRunning: false }),
            visit({ nodeId: "c", status: "active", taskRunning: true }),
          ],
        }),
      ),
    ).toBe("2 steps running: a, c");
  });

  test("a queued run names its open step", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "queued",
          visits: [visit({ nodeId: "triage", status: "active" })],
        }),
      ),
    ).toBe("Queued at triage");
  });

  test("a done run names its succeed node", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "done",
          endNodeId: "shipped",
          visits: [visit({ nodeId: "shipped", nodeKind: "succeed" })],
        }),
      ),
    ).toBe("Finished at shipped");
  });

  test("an ended run shows its fail end's error", () => {
    const ended = facts({ status: "ended", endNodeId: "rejected" });
    expect(pipelineRunStatusLine(ended)).toBe("Rejected");
    expect(pipelineRunOutcome(ended)).toBe("Rejected");
  });

  test("a fail end without an error names the end", () => {
    const ended = facts({ status: "ended", endNodeId: "abandoned" });
    expect(pipelineRunStatusLine(ended)).toBe("Ended at abandoned");
    expect(pipelineRunOutcome(ended)).toBeNull();
  });

  test("a crashed run shows its failed step's error message", () => {
    const failed = facts({
      status: "failed",
      visits: [
        visit({
          nodeId: "triage",
          status: "failed",
          error: { name: "Scarn.Timeout", message: "The step timed out" },
        }),
      ],
      error: { name: "Scarn.Timeout", message: "Uncaught Scarn.Timeout" },
    });
    expect(pipelineRunStatusLine(failed)).toBe("The step timed out");
    expect(pipelineRunOutcome(failed)).toBe("Scarn.Timeout");
  });

  test("a crashed run without a failed step falls back to the run's error", () => {
    const failed = facts({
      status: "failed",
      error: { name: "Engine.Bug", message: "Something broke" },
    });
    expect(pipelineRunStatusLine(failed)).toBe("Something broke");
    expect(pipelineRunOutcome(failed)).toBe("Engine.Bug");
  });

  test("cancelled says so and has no outcome", () => {
    const cancelled = facts({ status: "cancelled" });
    expect(pipelineRunStatusLine(cancelled)).toBe("Cancelled");
    expect(pipelineRunOutcome(cancelled)).toBeNull();
  });

  test("a run whose document is gone still gets a line", () => {
    expect(
      pipelineRunStatusLine(
        facts({
          status: "waiting",
          document: null,
          visits: [
            visit({ nodeId: "review", nodeKind: "wait", status: "waiting" }),
          ],
        }),
      ),
    ).toBe("Waiting at review");
  });
});
