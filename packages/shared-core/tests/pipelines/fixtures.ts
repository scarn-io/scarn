import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import { obj } from "./fixture-schema";

const evaluateResult = obj("EvaluateResult", {
  quality: { type: "number" },
  hasRumSession: { type: "boolean" },
  maxAttempts: { type: "integer" },
  summary: { type: "string" },
  missingDetails: { type: "array", items: { type: "string" } },
});

const reproduceResult = obj("ReproduceResult", {
  reproductionConfidence: { type: "number" },
  evidenceVerdict: { enum: ["reproduced", "not_reproduced", "inconclusive"] },
});

const failingTestResult = obj("FailingTestResult", {
  testPath: { type: "string" },
});

const proposeFixResult = obj("ProposeFixResult", {
  requiresHumanApproval: { type: "boolean" },
  summary: { type: "string" },
});

const fixResult = obj("FixResult", {
  testsPass: { type: "boolean" },
  attempts: { type: "integer" },
  changedFiles: { type: "array", items: { type: "string" } },
  finishedAt: { type: "string", format: "date-time" },
});

const reproduceInput = obj("ReproduceInput", {
  companyNames: { type: "string" },
  employeeEmails: { type: "string" },
  evaluation: evaluateResult,
});

export const bugSteps: StepCatalog = {
  evaluate: {
    inputSchema: obj("EvaluateInput", {
      companyNames: { type: "string" },
      employeeEmails: { type: "string" },
    }),
    resultSchema: evaluateResult,
    errors: [],
  },
  "reproduce-from-session": {
    inputSchema: reproduceInput,
    resultSchema: reproduceResult,
    errors: [],
  },
  "reproduce-from-logs": {
    inputSchema: reproduceInput,
    resultSchema: reproduceResult,
    errors: ["LogsUnavailable"],
  },
  "failing-test": {
    inputSchema: obj("FailingTestInput", {
      evaluation: evaluateResult,
      investigation: reproduceResult,
    }),
    resultSchema: failingTestResult,
    errors: [],
  },
  "propose-fix": {
    inputSchema: obj("ProposeFixInput", {
      evaluation: evaluateResult,
      investigation: reproduceResult,
      failingTest: failingTestResult,
    }),
    resultSchema: proposeFixResult,
    errors: [],
  },
  fix: {
    inputSchema: obj(
      "FixInput",
      {
        evaluation: evaluateResult,
        investigation: reproduceResult,
        failingTest: failingTestResult,
        plan: proposeFixResult,
        previousAttempt: fixResult,
      },
      ["evaluation", "investigation", "failingTest", "plan"],
    ),
    resultSchema: fixResult,
    errors: ["MergeConflict"],
  },
};

/** The spec's bug pipeline, minus the features rejected in v1. */
export function bugPipeline() {
  return {
    schemaVersion: 1,
    key: "bug-pipeline",
    title: "Bug triage and fix",
    workItemFields: {
      companyNames: "What are the Company Name(s):",
      employeeEmails: "What are the Employee Email(s):",
    },
    start: {
      to: "evaluate",
      args: {
        companyNames: "workItem.fields.companyNames",
        employeeEmails: "workItem.fields.employeeEmails",
      },
    },
    nodes: {
      evaluate: {
        kind: "step",
        step: "evaluate",
        next: {
          routes: [
            {
              when: { path: "result.quality", op: "lessThan", value: 0.1 },
              to: "ask-for-details",
              args: { questions: "result.missingDetails" },
            },
            {
              when: { path: "result.hasRumSession", op: "equal", value: true },
              to: "reproduce-from-session",
              args: {
                companyNames: "input.companyNames",
                employeeEmails: "input.employeeEmails",
                evaluation: "result",
              },
            },
          ],
          otherwise: {
            to: "reproduce-from-logs",
            args: {
              companyNames: "input.companyNames",
              employeeEmails: "input.employeeEmails",
              evaluation: "result",
            },
          },
        },
      },
      "ask-for-details": {
        kind: "wait",
        for: "reply",
        maxRuns: 2,
        catch: [{ on: ["Scarn.MaxRunsExceeded"], to: "insufficient-detail" }],
        next: {
          routes: [
            {
              to: "evaluate",
              args: {
                companyNames: "nodes.evaluate.input.companyNames",
                employeeEmails: "nodes.evaluate.input.employeeEmails",
              },
            },
          ],
        },
      },
      "reproduce-from-session": {
        kind: "step",
        step: "reproduce-from-session",
        next: {
          routes: [
            {
              when: {
                all: [
                  {
                    path: "result.reproductionConfidence",
                    op: "greaterThanInclusive",
                    value: 0.8,
                  },
                  {
                    path: "result.evidenceVerdict",
                    op: "equal",
                    value: "reproduced",
                  },
                ],
              },
              to: "failing-test",
              args: {
                evaluation: "nodes.evaluate.result",
                investigation: "result",
              },
            },
          ],
          otherwise: { to: "not-reproduced" },
        },
      },
      "reproduce-from-logs": {
        kind: "step",
        step: "reproduce-from-logs",
        catch: [{ on: ["Scarn.All"], to: "not-reproduced" }],
        next: {
          routes: [
            {
              when: {
                all: [
                  {
                    path: "result.reproductionConfidence",
                    op: "greaterThanInclusive",
                    value: 0.8,
                  },
                  {
                    path: "result.evidenceVerdict",
                    op: "equal",
                    value: "reproduced",
                  },
                ],
              },
              to: "failing-test",
              args: {
                evaluation: "nodes.evaluate.result",
                investigation: "result",
              },
            },
          ],
          otherwise: { to: "not-reproduced" },
        },
      },
      "failing-test": {
        kind: "step",
        step: "failing-test",
        next: {
          routes: [
            {
              to: "propose-fix",
              args: {
                evaluation: "nodes.evaluate.result",
                investigation: "input.investigation",
                failingTest: "result",
              },
            },
          ],
        },
      },
      "propose-fix": {
        kind: "step",
        step: "propose-fix",
        next: {
          routes: [
            {
              when: {
                path: "result.requiresHumanApproval",
                op: "equal",
                value: true,
              },
              to: "approve-fix",
              args: { request: "result" },
            },
          ],
          otherwise: {
            to: "fix",
            args: {
              evaluation: "nodes.evaluate.result",
              investigation: "nodes.failing-test.input.investigation",
              failingTest: "nodes.failing-test.result",
              plan: "result",
            },
          },
        },
      },
      "approve-fix": {
        kind: "wait",
        for: "decision",
        actions: [
          { key: "approve", label: "Approve", body: "optional" },
          { key: "reject", label: "Reject", body: "optional" },
        ],
        next: {
          routes: [
            {
              when: { path: "result.action", op: "equal", value: "approve" },
              to: "fix",
              args: {
                evaluation: "nodes.evaluate.result",
                investigation: "nodes.failing-test.input.investigation",
                failingTest: "nodes.failing-test.result",
                plan: "nodes.propose-fix.result",
              },
            },
          ],
          otherwise: { to: "fix-rejected" },
        },
      },
      fix: {
        kind: "step",
        step: "fix",
        timeoutSeconds: 3600,
        heartbeatSeconds: 300,
        maxRuns: 5,
        retry: [{ on: ["Scarn.HeartbeatTimeout"], maxAttempts: 2 }],
        next: {
          routes: [
            {
              when: { path: "result.testsPass", op: "equal", value: true },
              to: "done",
            },
          ],
          otherwise: {
            to: "fix",
            args: {
              evaluation: "input.evaluation",
              investigation: "input.investigation",
              failingTest: "input.failingTest",
              plan: "input.plan",
              previousAttempt: "result",
            },
          },
        },
      },
      done: { kind: "succeed" },
      "insufficient-detail": { kind: "fail", error: "InsufficientDetail" },
      "not-reproduced": { kind: "fail", error: "NotReproduced" },
      "fix-rejected": { kind: "fail", error: "FixRejected" },
    },
  };
}

/** The spec's full bug pipeline, including features that v1 rejects. */
export function fullSpecBugPipeline() {
  const document = bugPipeline() as ReturnType<typeof bugPipeline> &
    Record<string, unknown>;
  document["timeoutSeconds"] = 172800;
  (document.nodes["approve-fix"] as Record<string, unknown>)["timeoutSeconds"] =
    604800;
  document.nodes.fix.retry = [
    {
      on: ["Scarn.HeartbeatTimeout"],
      maxAttempts: 2,
      intervalSeconds: 60,
      backoffRate: 2,
    } as never,
  ];
  return document;
}

export type Doc = Record<string, unknown> & {
  nodes: Record<string, Record<string, unknown>>;
};

/** A deep copy of a fixture, typed loosely so tests can mutate it. */
export function clone(document: object): Doc {
  return structuredClone(document) as Doc;
}
