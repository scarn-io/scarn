"use client";

import { use, useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { Box, CircularProgress, Typography } from "@mui/material";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { fetchWorkItem } from "@/app/(protected)/projects/_lib/project-work-items";
import { useProjectRoute } from "@/components/project-route-context";
import { WorkItemDetailClient } from "@/components/work-items/work-item-detail-client";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; workItem: WorkItemContract };

export default function ProjectWorkItemDetailPage({
  params,
}: {
  params: Promise<{ workItemId: string }>;
}) {
  const { workItemId } = use(params);
  const { projectId } = useProjectRoute();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setState({ status: "loading" });
      try {
        const workItem = await fetchWorkItem(workItemId);
        if (cancelled) return;
        if (workItem.projectId !== projectId) {
          setState({ status: "not-found" });
          return;
        }
        setState({ status: "ready", workItem });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load";
        setState(
          message === "Work item not found"
            ? { status: "not-found" }
            : { status: "error", message },
        );
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, workItemId]);

  if (state.status === "not-found") {
    notFound();
  }

  if (state.status === "loading") {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 4 }}>
        <CircularProgress size={24} />
        <Typography color="text.secondary">Loading work item…</Typography>
      </Box>
    );
  }

  if (state.status === "error") {
    return (
      <Typography color="error" sx={{ mt: 4 }}>
        {state.message}
      </Typography>
    );
  }

  return (
    <WorkItemDetailClient projectId={projectId} initialWorkItem={state.workItem} />
  );
}
