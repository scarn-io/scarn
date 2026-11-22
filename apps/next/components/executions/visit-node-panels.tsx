"use client";

import { Box, Typography } from "@mui/material";
import type { NodeVisitContract } from "@scarn/api/frontend-contracts";
import { formatDateTime } from "./format-datetime";
import { calloutPanelSx } from "./panel-styles";
import { TextLink } from "./thread-parts";

/** A succeed/fail node ends the run (or its lane): show how. */
export function EndNodePanel({
  visit,
  onOpenDetails,
}: {
  visit: NodeVisitContract;
  onOpenDetails: () => void;
}) {
  const failed = visit.nodeKind === "fail";
  return (
    <Box sx={calloutPanelSx(failed ? "error" : "info")}>
      <Typography variant="subtitle2">
        {failed ? "Run ended in failure" : "Run ended successfully"}
      </Typography>
      {visit.error ? (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {visit.error.name}: {visit.error.message}
        </Typography>
      ) : null}
      <Typography variant="caption" color="text.secondary">
        {formatDateTime(visit.completedAt ?? visit.createdAt)}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        <TextLink onClick={onOpenDetails}>Show details</TextLink>
      </Typography>
    </Box>
  );
}
