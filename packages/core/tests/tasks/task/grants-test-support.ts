import type {
  Grant,
  GrantAction,
  GrantScope,
} from "@/tasks/task/domain/grants";

/** One work item grant; `labels` only for `label` and `create`. */
export const grant = (
  action: GrantAction,
  scope: GrantScope,
  labels?: string[],
): Grant =>
  ({
    resource: "workItem",
    action,
    scope,
    ...(labels ? { labels } : {}),
  }) as Grant;

/**
 * Every work item action on `scope` (`create` only on `children`), with
 * `label` and `create` limited to `labels`.
 */
export const allGrants = (scope: GrantScope, labels: string[]): Grant[] => [
  grant("read", scope),
  grant("update", scope),
  grant("comment", scope),
  grant("label", scope, labels),
  grant("block", scope),
  grant("close", scope),
  ...(scope === "children" ? [grant("create", "children", labels)] : []),
];
