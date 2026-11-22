import { z } from "zod";
import { CoreValidationError } from "@scarn/core/lib/errors";

// Canonical vocabulary. This is the set of permissions the application
// currently knows how to grant and enforce. It is intentionally NOT used when
// reading/rehydrating persisted permissions: stored data may legitimately
// contain permissions from older or newer deploys, and reads must never fail
// on an unrecognized-but-well-formed permission. New permissions are added
// here and take effect at the grant boundary only.
//
// Record resources get every action. Config resources (pipelines, settings,
// integrations, members) only have `write`: reading them is covered by
// `executions:read` / `work-items:read`.
const RECORD_RESOURCES = [
  "work-items",
  "executions",
  "comments",
  "work-item-platform-comment",
  "secrets",
] as const;
const CONFIG_RESOURCES = [
  "pipelines",
  "settings",
  "integrations",
  "members",
] as const;
export const PROJECT_RESOURCES = [
  ...RECORD_RESOURCES,
  ...CONFIG_RESOURCES,
] as const;
export const PROJECT_ACTIONS = [
  "read",
  "write",
  "create",
  "update",
  "delete",
] as const;

export const PROJECT_PERMISSIONS: readonly string[] = [
  ...RECORD_RESOURCES.flatMap((resource) =>
    PROJECT_ACTIONS.map((action) => `${resource}:${action}`),
  ),
  ...CONFIG_RESOURCES.map((resource) => `${resource}:write`),
].sort();

const isPermissionFormat = (value: string): boolean => {
  const [resource, action, ...rest] = value.split(":");

  return (
    rest.length === 0 &&
    resource !== undefined &&
    resource.length > 0 &&
    action !== undefined &&
    action.length > 0
  );
};

// Format-only schema. Accepts any well-formed `<resource>:<action>` string.
// Used everywhere permissions are constructed or rehydrated so that persisted
// data always loads regardless of the current vocabulary.
export const projectPermissionSchema = z
  .string()
  .trim()
  .refine(isPermissionFormat, "Permission must match <resource>:<action>");

// Strict schema. Only accepts permissions from the canonical vocabulary above.
// Used at grant-time boundaries (e.g. API input) to catch typos and reject
// permissions the application does not yet support.
export const grantableProjectPermissionSchema = z
  .string()
  .trim()
  .refine(
    (value) => PROJECT_PERMISSIONS.includes(value),
    "Permission must be a supported <resource>:<action>",
  );

export const projectPermissionListSchema = z
  .array(projectPermissionSchema)
  .transform((permissions) => [...new Set(permissions)].sort());

export const grantableProjectPermissionListSchema = z
  .array(grantableProjectPermissionSchema)
  .transform((permissions) => [...new Set(permissions)].sort());

export type ProjectPermission = z.infer<typeof projectPermissionSchema>;

export const parseProjectPermission = (value: string): ProjectPermission => {
  const parsed = projectPermissionSchema.safeParse(value);

  if (!parsed.success) {
    throw new CoreValidationError(
      `Invalid project permission: ${value}`,
      "INVALID_PROJECT_PERMISSION",
    );
  }

  return parsed.data;
};

export const parseProjectPermissions = (
  values: readonly string[],
): ProjectPermission[] => {
  const parsed = projectPermissionListSchema.safeParse(values);

  if (!parsed.success) {
    throw new CoreValidationError(
      "Invalid project permissions",
      "INVALID_PROJECT_PERMISSIONS",
    );
  }

  return parsed.data;
};

// Grant-time validation: rejects any permission outside the canonical
// vocabulary. Call this when a caller is assigning permissions, NOT when
// loading them from storage.
export const parseGrantableProjectPermissions = (
  values: readonly string[],
): ProjectPermission[] => {
  const parsed = grantableProjectPermissionListSchema.safeParse(values);

  if (!parsed.success) {
    throw new CoreValidationError(
      "Invalid project permissions",
      "INVALID_PROJECT_PERMISSIONS",
    );
  }

  return parsed.data;
};

export const hasProjectPermission = (
  permissions: readonly ProjectPermission[],
  permission: ProjectPermission,
): boolean => permissions.includes(permission);

// True for any `<resource>:read` permission, regardless of resource. Used to
// decide whether a permission is eligible for the public-project visibility
// fallback in `assertProjectPermission` — only reads ever fall back that way,
// never `write`/`create`/`update`/`delete`, even on a public project.
export const isReadProjectPermission = (
  permission: ProjectPermission,
): boolean => permission.endsWith(":read");
