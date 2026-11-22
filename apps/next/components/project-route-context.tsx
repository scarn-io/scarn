"use client";

import { createContext, useCallback, useContext } from "react";
import {
  projectPath,
  projectSubPath,
} from "@/app/(protected)/projects/_lib/project-routing";

/**
 * Identifies the project addressed by the current pretty URL
 * (`/{username}/{projectSlug}`). Provided once at the project layout from data
 * resolved server-side; every internal project link is rebuilt from these live
 * values, so a username/slug rename self-heals all in-app navigation.
 *
 * `projectId` is the resolved UUID used for data fetching; `username` +
 * `projectSlug` are used only for building URLs. `isMember` is whether the
 * current viewer (anonymous or logged in) holds a membership row on this
 * project — `false` for a public project's non-member/anonymous viewer (issue
 * #150), always `true` on a private project (a non-member never resolves one
 * far enough to reach this provider). Every write affordance and every
 * member-only page reads this rather than re-deriving it. `permissions` is
 * the current viewer's own `ProjectPermission[]` from their membership row
 * (empty for a non-member) — finer-grained than `isMember`, for gates that
 * need to distinguish permission levels within membership, not just presence.
 * `role` is the viewer's project role name (`null` for a non-member), for
 * display only: gate on `permissions`, never on `role`.
 */
type ProjectRoute = {
  username: string;
  projectSlug: string;
  projectId: string;
  isMember: boolean;
  role: string | null;
  permissions: string[];
};

const ProjectRouteContext = createContext<ProjectRoute | null>(null);

export function ProjectRouteProvider({
  username,
  projectSlug,
  projectId,
  isMember,
  role = null,
  permissions = [],
  children,
}: Omit<ProjectRoute, "role" | "permissions"> & {
  role?: string | null;
  permissions?: string[];
  children: React.ReactNode;
}) {
  return (
    <ProjectRouteContext.Provider
      value={{ username, projectSlug, projectId, isMember, role, permissions }}
    >
      {children}
    </ProjectRouteContext.Provider>
  );
}

export function useProjectRoute(): ProjectRoute {
  const value = useContext(ProjectRouteContext);
  if (!value) {
    throw new Error(
      "useProjectRoute must be used within a ProjectRouteProvider",
    );
  }
  return value;
}

/** Convenience accessor for the one field most write-affordance gating needs. */
export function useIsProjectMember(): boolean {
  return useProjectRoute().isMember;
}

/** Whether the current viewer's own membership on this project includes
 * `permission`. Unlike `useIsProjectMember`, this is permission-level, not
 * just membership-presence — the first UI gate in this app that needs that
 * distinction (see `docs/plans/agent-drafted-comment-approval.md`, Phase 8's
 * "To verify" note). Always `false` for a non-member (empty `permissions`
 * array from the provider's default). */
export function useHasProjectPermission(permission: string): boolean {
  return useProjectRoute().permissions.includes(permission);
}

/**
 * Returns a builder for paths under the current project, e.g.
 * `buildPath("work-items", workItemId)` → `/{username}/{projectSlug}/work-items/{workItemId}`.
 * Always sourced from live context values.
 */
export function useProjectPath(): (...segments: string[]) => string {
  const { username, projectSlug } = useProjectRoute();
  return useCallback(
    (...segments: string[]) =>
      segments.length === 0
        ? projectPath(username, projectSlug)
        : projectSubPath(username, projectSlug, ...segments),
    [username, projectSlug],
  );
}
