"use client";

/**
 * A run's page: the shared {@link RunHeader} over one pane that fills the
 * rest of the height. A single-step run (a Task, a chat) has no rail, so the
 * pane takes the full width. When the id is not a Runs-list row of this kind
 * (a Task a pipeline's node visit ran), the header is left out and the pane
 * shows its own.
 */

import { Alert, Box } from "@mui/material";
import type { ReactNode } from "react";
import { authClient } from "@/app/_lib/auth-client";
import { CONTENT_MAX_WIDTH } from "@/components/theme-provider";
import { RunHeader, type RunHeaderProps } from "./run-header";
import type { ProjectRunLookup } from "./runs-api";
import { useProjectRun, type ProjectRunData } from "./use-project-run";

export type RunFramePane = {
  /** Whether the frame's header stands in for the pane's own. */
  framed: boolean;
  data: ProjectRunData;
};

export type RunFrameProps = {
  projectId: string;
  lookup: ProjectRunLookup;
  /**
   * `scroll`: the pane scrolls inside a centred column (a Task).
   * `fill`: the pane fills the height and scrolls itself (a chat).
   */
  layout: "scroll" | "fill";
  /** Overrides the row's poll interval (tests). */
  pollIntervalMs?: number;
} & Pick<RunHeaderProps, "stepsSoFar" | "placesAtOnce" | "actions"> & {
    children: (pane: RunFramePane) => ReactNode;
  };

export function RunFrame({
  projectId,
  lookup,
  layout,
  pollIntervalMs,
  stepsSoFar,
  placesAtOnce,
  actions,
  children,
}: RunFrameProps) {
  const data = useProjectRun(projectId, lookup, pollIntervalMs);
  const viewerUserId = authClient.useSession().data?.user.id ?? null;
  const framed = !data.notFound;

  return (
    <Box
      data-testid="run-frame"
      sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      {framed ? (
        <RunHeader
          run={data.run}
          viewerUserId={viewerUserId}
          stepsSoFar={stepsSoFar}
          placesAtOnce={placesAtOnce}
          actions={actions}
        />
      ) : null}
      {data.error && !data.run ? (
        <Alert severity="warning" sx={{ mx: { xs: 2, md: 3 }, mt: 1.5 }}>
          {data.error}
        </Alert>
      ) : null}
      {layout === "fill" ? (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {children({ framed, data })}
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <Box
            sx={{
              maxWidth: CONTENT_MAX_WIDTH,
              mx: "auto",
              width: "100%",
              px: { xs: 2, md: 4 },
              py: 3,
            }}
          >
            {children({ framed, data })}
          </Box>
        </Box>
      )}
    </Box>
  );
}
