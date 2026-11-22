import { z } from "zod";

// A project is `private` by default: only members can read or write its
// work items, executions, and comments. `public` grants read-only access to
// any actor — including one with no session at all — without a membership
// row; write access always still requires an explicit membership grant. See
// `assertProjectPermission` for where the fallback is applied.
export const PROJECT_VISIBILITIES = ["private", "public"] as const;

export const projectVisibilitySchema = z.enum(PROJECT_VISIBILITIES);

export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;

export const DEFAULT_PROJECT_VISIBILITY: ProjectVisibility = "private";

export const parseProjectVisibility = (
  value: string | null | undefined,
): ProjectVisibility => {
  if (value == null) {
    return DEFAULT_PROJECT_VISIBILITY;
  }

  return projectVisibilitySchema.parse(value);
};
