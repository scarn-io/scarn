import type {
  JsonObject,
  StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import issueTriage from "../../../../../sdks/js/test/pipelines/fixtures/issue-triage";
import { obj } from "./engine-fixture-schema";
import { RunSimulator } from "./engine-harness";

/** The plan's `match: "all"` example, compiled by the SDK. */
export function triageDocument(): JsonObject {
  return structuredClone(issueTriage.document) as unknown as JsonObject;
}

export const triageSteps: StepCatalog = issueTriage.steps;

export const CLASSIFIED = {
  appUrl: "https://app.test",
  category: "security",
  summary: "Checkout crashes",
  affectedPages: ["/cart", "/pay"],
  duplicateCount: 1,
  duplicateIds: ["d1"],
};

export function triageRun(
  classified: object = CLASSIFIED,
  document: object = triageDocument(),
): RunSimulator {
  const run = new RunSimulator(document, triageSteps).start();
  run.succeed("classify-issue", classified as JsonObject);
  return run;
}

const none = obj("None", {});

export const forkSteps: StepCatalog = {
  pick: {
    inputSchema: obj("PickInput", { request: { type: "string" } }),
    resultSchema: obj("PickResult", {
      left: { type: "boolean" },
      right: { type: "boolean" },
    }),
    errors: [],
  },
  left: {
    inputSchema: none,
    resultSchema: obj("LeftResult", { v: { type: "string" } }),
    errors: [],
  },
  right: {
    inputSchema: none,
    resultSchema: obj("RightResult", { v: { type: "string" } }),
    errors: [],
  },
  fallback: { inputSchema: none, resultSchema: none, errors: [] },
  collect: {
    inputSchema: obj(
      "CollectInput",
      { left: { type: "string" }, right: { type: "string" } },
      [],
    ),
    resultSchema: none,
    errors: [],
  },
};

/**
 * `pick` takes `left` and/or `right` side by side, both conditional.
 * `merge`: they meet at `collect` with `partial` routes. `otherwise`: a
 * `fallback` lane when neither matched, ending at the shared `done`.
 */
export function forkDocument(options: {
  merge: boolean;
  otherwise: boolean;
}): object {
  const toCollect = (field: string) =>
    options.merge
      ? {
          next: {
            routes: [
              {
                to: "collect",
                args: { [field]: "result.v" },
                partial: true,
              },
            ],
          },
        }
      : {};
  return {
    schemaVersion: 1,
    key: "fork",
    start: { to: "pick", args: { request: "workItem.title" } },
    nodes: {
      pick: {
        kind: "step",
        step: "pick",
        next: {
          match: "all",
          routes: [
            {
              when: { path: "result.left", op: "equal", value: true },
              to: "left",
            },
            {
              when: { path: "result.right", op: "equal", value: true },
              to: "right",
            },
          ],
          ...(options.otherwise ? { otherwise: { to: "fallback" } } : {}),
        },
      },
      left: { kind: "step", step: "left", ...toCollect("left") },
      right: { kind: "step", step: "right", ...toCollect("right") },
      ...(options.otherwise
        ? {
            fallback: {
              kind: "step",
              step: "fallback",
              next: { routes: [{ to: "done" }] },
            },
          }
        : {}),
      ...(options.merge
        ? {
            collect: {
              kind: "step",
              step: "collect",
              next: { routes: [{ to: "done" }] },
            },
          }
        : {}),
      ...(options.merge || options.otherwise
        ? { done: { kind: "succeed" } }
        : {}),
    },
  };
}
