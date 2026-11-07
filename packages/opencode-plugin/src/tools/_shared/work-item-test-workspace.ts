import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  type Grant,
  type GrantAction,
  type GrantScope,
} from "./current-execution";

/** Test support: the labels `create` and `label` grants allow by default. */
export const TEST_GRANT_LABELS = ["bug", "triage", "ui"];

/** Test support: one work item grant, with `labels` where the action takes them. */
export function grant(
  action: GrantAction,
  scope: GrantScope,
  labels: string[] = TEST_GRANT_LABELS,
): Grant {
  if (action === "create") {
    return { resource: "workItem", action, scope: "children", labels };
  }
  if (action === "read") {
    return { resource: "workItem", action, scope };
  }
  if (scope === "project") {
    throw new Error(`No ${action} grant covers the project`);
  }
  if (action === "label") {
    return { resource: "workItem", action, scope, labels };
  }
  return { resource: "workItem", action, scope };
}

/** Test support: every grant on `self` and `children`. */
export const ALL_GRANTS: Grant[] = [
  grant("read", "self"),
  grant("update", "self"),
  grant("comment", "self"),
  grant("label", "self"),
  grant("block", "self"),
  grant("close", "self"),
  grant("read", "children"),
  grant("update", "children"),
  grant("comment", "children"),
  grant("label", "children"),
  grant("block", "children"),
  grant("close", "children"),
  grant("create", "children"),
];

/** Test support: a temp workspace with the given execution info fields. */
export async function workItemTestWorkspace(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "scarn-wi-"));
  const infoPath = path.join(
    workspacePath,
    CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  );
  await mkdir(path.dirname(infoPath), { recursive: true });
  await Bun.write(
    infoPath,
    JSON.stringify({
      taskRunId: "task-run-1",
      resultSchemaJson: null,
      turnsRemaining: 3,
      workItemId: "item-self",
      grants: ALL_GRANTS,
      api: { baseUrl: "http://api.test/", claimToken: "claim-1" },
      ...overrides,
    }),
  );
  return workspacePath;
}
