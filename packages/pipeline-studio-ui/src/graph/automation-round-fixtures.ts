// Shared test fixtures for the automation round: the wayfinder automation
// and its steps' grants. Not exported from the package.
import type { Grant } from "@scarn/sdk/definitions/steps";
import type { AutomationGraphInput } from "./automation-document-parse";

export const NO_GRANTS: ReadonlyMap<string, readonly Grant[]> = new Map();
export const NO_PIPELINES: ReadonlyMap<string, string> = new Map();

export const WAYFINDER_LABELS = [
  "wayfinder:research",
  "wayfinder:prototype",
  "wayfinder:grilling",
  "wayfinder:task",
];

export function labelled(value: string) {
  return { path: "event.child.labels", op: "contains", value };
}

export function automation(
  key: string,
  scope: "project" | "workItem",
  rules: unknown[],
): AutomationGraphInput {
  return {
    key,
    document: { kind: "automation", schemaVersion: 1, key, scope, rules },
  };
}

const childRoute = (label: string, step: string) => ({
  when: labelled(`wayfinder:${label}`),
  kind: "step",
  to: step,
  on: "child",
});

export const WAYFINDER = automation("wayfinder", "workItem", [
  {
    event: "self.attached",
    next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
  },
  {
    event: "child.ready",
    next: {
      routes: [
        childRoute("research", "research"),
        childRoute("prototype", "prototype"),
        childRoute("grilling", "grilling"),
      ],
    },
  },
  {
    event: "child.closed",
    next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
  },
]);

export const selfGrant = (action: "update" | "comment" | "close"): Grant => ({
  resource: "workItem",
  action,
  scope: "self",
});

const WORKER_GRANTS: Grant[] = [
  selfGrant("update"),
  selfGrant("comment"),
  selfGrant("close"),
];

export const WAYFINDER_GRANTS: ReadonlyMap<string, readonly Grant[]> = new Map([
  [
    "plan",
    [
      { resource: "workItem", action: "read", scope: "self" },
      selfGrant("update"),
      {
        resource: "workItem",
        action: "create",
        scope: "children",
        labels: WAYFINDER_LABELS,
      },
      selfGrant("close"),
    ],
  ],
  ["research", WORKER_GRANTS],
  ["prototype", WORKER_GRANTS],
  ["grilling", WORKER_GRANTS],
]);
