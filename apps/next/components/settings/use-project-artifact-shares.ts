"use client";

import { useCallback, useMemo, useState } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { ProjectArtifactShareContract } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";

export type ProjectArtifactSharesData = {
  /** The project's active share links, seeded from the server and updated after each revoke. */
  shares: ProjectArtifactShareContract[];
  /** Whether the server-side fetch found more links than the 50 it returned. */
  hasMore: boolean;
  /** True while a revoke request is in flight. */
  loading: boolean;
  /** Revoke error message, or "" when there is none. */
  error: string;
  /** Revokes one bundle's share link. Resolves `true` (and drops the row) on success, `false` with `error` set on failure. */
  revoke: (share: ProjectArtifactShareContract) => Promise<boolean>;
};

/**
 * Owns the Settings "Active share links" list's revoke mutation. Like
 * {@link useProjectArtifacts}, it does not fetch: `page.tsx` performs the one
 * list fetch and seeds it via `initialShares`/`initialHasMore`. A revoked
 * link is removed from local state once the API confirms it.
 */
export function useProjectArtifactShares(
  projectId: string,
  initialShares: ProjectArtifactShareContract[],
  initialHasMore: boolean,
): ProjectArtifactSharesData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [shares, setShares] =
    useState<ProjectArtifactShareContract[]>(initialShares);
  const [hasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const revoke = useCallback(
    async (share: ProjectArtifactShareContract): Promise<boolean> => {
      setError("");
      setLoading(true);
      const { error: revokeError } = await apiClient.api
        .projects({ projectId: parseUuidV7(projectId) })
        ["artifact-bundles"]({ bundleId: parseUuidV7(share.bundleId) })
        .share.delete();
      setLoading(false);
      if (revokeError) {
        setError(parseApiError(revokeError, "Could not revoke the link."));
        return false;
      }
      setShares((current) => current.filter((item) => item.id !== share.id));
      return true;
    },
    [apiClient, projectId],
  );

  return { shares, hasMore, loading, error, revoke };
}
