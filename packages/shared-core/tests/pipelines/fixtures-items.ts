import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import { obj } from "./fixture-schema";

const reviewResult = obj("ReviewResult", {
  approved: { type: "boolean" },
  confidence: { type: "number" },
  notes: { type: "string" },
});

export const itemSteps: StepCatalog = {
  "plan-changes": {
    inputSchema: obj("PlanChangesInput", { request: { type: "string" } }),
    resultSchema: obj("PlanChangesResult", {
      files: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
      count: { type: "integer" },
    }),
    errors: [],
  },
  "edit-file": {
    inputSchema: obj("EditFileInput", {
      file: { type: "string" },
      planSummary: { type: "string" },
    }),
    resultSchema: obj("EditFileResult", {
      path: { type: "string" },
      diff: { type: "string" },
    }),
    errors: [],
  },
  "review-edit": {
    inputSchema: obj("ReviewEditInput", {
      path: { type: "string" },
      diff: { type: "string" },
    }),
    resultSchema: reviewResult,
    errors: [],
  },
  "open-pr": {
    inputSchema: obj("OpenPrInput", {
      request: { type: "string" },
      reviews: { type: "array", items: reviewResult },
    }),
    resultSchema: obj("OpenPrResult", { url: { type: "string" } }),
    errors: [],
  },
};

/** The spec's per-item lanes example: each file's review merges into one approval. */
export function itemsPipeline() {
  return {
    schemaVersion: 1,
    key: "items-pipeline",
    start: { to: "plan-changes", args: { request: "workItem.title" } },
    nodes: {
      "plan-changes": {
        kind: "step",
        step: "plan-changes",
        next: {
          routes: [
            {
              to: "edit-file",
              each: {
                over: "result.files",
                maxConcurrency: 5,
                toleratedFailures: { count: 1 },
              },
              args: { file: "item", planSummary: "result.summary" },
            },
          ],
        },
      },
      "edit-file": {
        kind: "step",
        step: "edit-file",
        next: {
          routes: [
            {
              to: "review-edit",
              args: { path: "result.path", diff: "result.diff" },
            },
          ],
        },
      },
      "review-edit": {
        kind: "step",
        step: "review-edit",
        next: {
          routes: [
            {
              to: "approve-reviews",
              args: { reviews: { list: ["result"] } },
              partial: true,
            },
          ],
        },
      },
      "approve-reviews": {
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
              to: "open-pr",
              args: {
                request: "nodes.plan-changes.input.request",
                reviews: "input.reviews",
              },
            },
          ],
          otherwise: { to: "changes-rejected" },
        },
      },
      "open-pr": {
        kind: "step",
        step: "open-pr",
        next: {
          routes: [{ to: "done" }],
        },
      },
      done: { kind: "succeed" },
      "changes-rejected": { kind: "fail", error: "ChangesRejected" },
    },
  };
}
