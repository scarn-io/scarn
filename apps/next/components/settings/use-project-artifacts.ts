"use client";

import { useCallback, useMemo, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { deleteProjectArtifactsInputSchema } from "@scarn/api/frontend-contracts";
import type { ProjectArtifactContract } from "@scarn/api/frontend-contracts";

export type ProjectArtifactsData = {
  /** The project's artifacts, seeded from the server and updated optimistically. */
  artifacts: ProjectArtifactContract[];
  /** Whether the server-side initial fetch found more artifacts than were returned (decision 10: no client-side "load more" in v1). */
  hasMore: boolean;
  /** True while a delete (single or batch) request is in flight. */
  loading: boolean;
  /** Delete error message, or "" when there is none. */
  error: string;
  /** Removes `ids` from local state without calling the API — used internally by {@link deleteOne}/{@link deleteMany} on success, and exposed for callers that already know a delete succeeded elsewhere. */
  removeArtifacts: (ids: string[]) => void;
  /** Deletes a single artifact via the single-item endpoint. Resolves `true` on success (after optimistically removing it from local state) or `false` on failure (with `error` set). */
  deleteOne: (artifactId: string) => Promise<boolean>;
  /** Deletes multiple artifacts via the batch endpoint. Resolves `true` on success (after optimistically removing them from local state) or `false` on failure (with `error` set). */
  deleteMany: (artifactIds: string[]) => Promise<boolean>;
};

/**
 * Owns the project-wide artifact list's delete mutations. Unlike
 * {@link useTaskRunArtifacts}, this hook does not fetch on mount: the
 * Settings page's Artifacts section is always visible (not lazily
 * expanded), so the server-rendered `page.tsx` performs the one and only
 * list fetch and seeds this hook via `initialArtifacts`/`initialHasMore`.
 * Deletes are applied optimistically to local state — no refetch.
 *
 * Error-handling mirrors `project-integrations-panel.tsx`'s convention
 * (destructure `{ error }` from the treaty response and surface it via
 * `parseApiError`), not `use-task-run-artifacts.ts`'s read-side
 * try/catch-plus-shape-guard style, since this hook's calls are pure
 * mutations with a single well-known response shape.
 */
export function useProjectArtifacts(
  projectId: string,
  initialArtifacts: ProjectArtifactContract[],
  initialHasMore: boolean,
): ProjectArtifactsData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [artifacts, setArtifacts] =
    useState<ProjectArtifactContract[]>(initialArtifacts);
  const [hasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const removeArtifacts = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setArtifacts((current) =>
      current.filter((artifact) => !idSet.has(artifact.id)),
    );
  }, []);

  const deleteOne = useCallback(
    async (artifactId: string): Promise<boolean> => {
      setError("");
      setLoading(true);
      const { error: deleteError } = await apiClient.api
        .projects({ projectId })
        .artifacts({ artifactId })
        .delete();
      setLoading(false);
      if (deleteError) {
        setError(
          parseApiError(deleteError, "Could not delete the artifact."),
        );
        return false;
      }
      removeArtifacts([artifactId]);
      return true;
    },
    [apiClient, projectId, removeArtifacts],
  );

  const deleteMany = useCallback(
    async (artifactIds: string[]): Promise<boolean> => {
      if (artifactIds.length === 0) {
        return true;
      }
      setError("");
      setLoading(true);
      const input = deleteProjectArtifactsInputSchema.parse(artifactIds);
      const { error: deleteError } = await apiClient.api
        .projects({ projectId })
        .artifacts.batch.delete({ input });
      setLoading(false);
      if (deleteError) {
        setError(
          parseApiError(
            deleteError,
            "Could not delete the selected artifacts.",
          ),
        );
        return false;
      }
      removeArtifacts(artifactIds);
      return true;
    },
    [apiClient, projectId, removeArtifacts],
  );

  return {
    artifacts,
    hasMore,
    loading,
    error,
    removeArtifacts,
    deleteOne,
    deleteMany,
  };
}
