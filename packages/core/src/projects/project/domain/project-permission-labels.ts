/**
 * Human-readable labels for `<resource>:<action>` project permissions.
 *
 * Dependency-free so it can be bundled into Next client components through
 * `@scarn/api/frontend-contracts`. Keyed by the canonical vocabulary in
 * `project-permission.ts`; a permission outside it (from an older or newer
 * deploy) falls back to its raw string rather than failing.
 */

export const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  "work-items": "work items",
  executions: "pipeline runs",
  comments: "comments",
  "work-item-platform-comment": "tracker comments",
  secrets: "project secrets",
  pipelines: "pipelines",
  settings: "project settings",
  integrations: "integrations",
  members: "members and invites",
};

export const ACTION_LABELS: Readonly<Record<string, string>> = {
  read: "View",
  write: "Edit",
};

export function formatProjectPermission(permission: string): string {
  const [resource, action, ...rest] = permission.split(":");
  if (resource === undefined || action === undefined || rest.length > 0) {
    return permission;
  }
  const resourceLabel = RESOURCE_LABELS[resource];
  const actionLabel = ACTION_LABELS[action];
  if (resourceLabel === undefined || actionLabel === undefined) {
    return permission;
  }
  return `${actionLabel} ${resourceLabel}`;
}
