"use client";

import { useEffect, useState } from "react";
import type { ProjectMemberContract } from "@scarn/api/frontend-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";

export type ProjectMembersData = {
  members: readonly ProjectMemberContract[];
  loading: boolean;
  error: string | null;
};

/**
 * The project's members with their display fields. The endpoint is
 * members-only, so pass `enabled: false` for a non-member viewer.
 */
export function useProjectMembers(
  projectId: string,
  enabled: boolean,
): ProjectMembersData {
  const [members, setMembers] = useState<readonly ProjectMemberContract[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setMembers([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getBrowserScarnApiClient()
      .api.projects({ projectId: parseUuidV7(projectId) })
      .members.get()
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) {
          setError(parseApiError(err, "Could not load project members."));
          return;
        }
        setMembers(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, enabled]);

  return { members, loading, error };
}
