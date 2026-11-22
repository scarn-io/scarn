"use client";

import {
  Alert,
  AlertTitle,
  Box,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { z } from "zod";
import type { CommentDraftArtifactResolutionContract } from "@scarn/api/frontend-contracts";
import { apiErrorCode, apiErrorMeta } from "@/app/_lib/api-error";
import { humanizeArtifactMarkerReason } from "@/components/artifacts/artifact-marker-reason";

const unavailableArtifactMarkersSchema = z.array(
  z.object({
    markerIndex: z.number().int(),
    caption: z.string(),
    reason: z.string(),
  }),
);

export type UnavailableArtifactMarker = z.infer<
  typeof unavailableArtifactMarkersSchema
>[number];

/**
 * The markers named by a 422 `artifact_unavailable` approval error, or null
 * for any other error.
 */
export function unavailableArtifactMarkers(
  // eslint-disable-next-line local/no-unknown-parameter-type
  error: unknown,
): UnavailableArtifactMarker[] | null {
  if (apiErrorCode(error) !== "artifact_unavailable") return null;
  const parsed = unavailableArtifactMarkersSchema.safeParse(
    apiErrorMeta(error)?.["markers"],
  );
  return parsed.success ? parsed.data : [];
}

/** Approval-blocked banner naming each marker that is no longer available. */
export function ArtifactApprovalBlockedBanner({
  markers,
}: {
  markers: UnavailableArtifactMarker[];
}) {
  return (
    <Alert severity="warning">
      <AlertTitle>Can&apos;t post this comment yet</AlertTitle>
      {markers.length > 0 ? (
        <>
          These artifacts are no longer available. Remove their markers or
          reject the draft.
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
            {markers.map((marker) => (
              <li key={marker.markerIndex}>
                <strong>{marker.caption || "Untitled artifact"}</strong>
                {" — "}
                {humanizeArtifactMarkerReason(marker.reason)}
              </li>
            ))}
          </Box>
        </>
      ) : (
        "One or more artifacts in this comment are no longer available."
      )}
    </Alert>
  );
}

/** Side panel listing optional artifacts removed from the draft, with why. */
export function ArtifactLeftOutPanel({
  leftOut,
}: {
  leftOut: CommentDraftArtifactResolutionContract["leftOut"];
}) {
  return (
    <Paper variant="outlined" sx={{ p: 1.25 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 600, display: "block", mb: 0.75 }}
      >
        Left out
      </Typography>
      <Stack spacing={0.75}>
        {leftOut.map((entry) => (
          <Box key={entry.markerIndex}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {entry.caption || "Untitled artifact"}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {humanizeArtifactMarkerReason(entry.reason)}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}
