import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import { obj } from "./fixture-schema";
import { clone, type Doc } from "./fixtures";

const plan = obj("Plan", { summary: { type: "string" } });

export const decisionSteps: StepCatalog = {
  "propose-fix": {
    inputSchema: obj(
      "ProposeFixInput",
      { title: { type: "string" }, feedback: { type: ["string", "null"] } },
      ["title"],
    ),
    resultSchema: plan,
    errors: [],
  },
  "apply-fix": {
    inputSchema: obj("ApplyFixInput", { plan }),
    resultSchema: obj("ApplyFixResult", { changed: { type: "boolean" } }),
    errors: [],
  },
};

/** The plan's review loop: approve applies the fix, revise sends the body back to propose-fix. */
export function decisionPipeline(): Doc {
  return clone({
    schemaVersion: 1,
    key: "review-loop",
    start: { to: "propose-fix", args: { title: "workItem.title" } },
    nodes: {
      "propose-fix": {
        kind: "step",
        step: "propose-fix",
        next: { routes: [{ to: "review-fix", args: { plan: "result" } }] },
      },
      "review-fix": {
        kind: "wait",
        for: "decision",
        actions: [
          { key: "approve", label: "Approve", body: "optional" },
          { key: "revise", label: "Request changes", body: "required" },
          { key: "reject", label: "Reject" },
        ],
        next: {
          routes: [
            {
              when: { path: "result.action", op: "equal", value: "approve" },
              to: "apply-fix",
              args: { plan: "nodes.propose-fix.result" },
            },
            {
              when: { path: "result.action", op: "equal", value: "revise" },
              to: "propose-fix",
              args: { title: "workItem.title", feedback: "result.body" },
            },
          ],
          otherwise: { to: "rejected" },
        },
      },
      "apply-fix": {
        kind: "step",
        step: "apply-fix",
        next: { routes: [{ to: "done" }] },
      },
      done: { kind: "succeed" },
      rejected: { kind: "fail", error: "FixRejected" },
    },
  });
}
