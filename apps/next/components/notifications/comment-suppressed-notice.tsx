"use client";

import Link from "next/link";
import { Alert, AlertTitle, Button } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { z } from "zod";
import type { UserNotificationContract } from "@scarn/api/frontend-contracts";
import { useProjectPath } from "@/components/project-route-context";
import { humanizeArtifactMarkerReason } from "@/components/artifacts/artifact-marker-reason";

type CommentSuppressed = {
  reason: string;
  caption: string;
  stepKey: string | null;
};

const commentSuppressedSchema = z.object({
  reason: z.string(),
  artifact: z
    .object({
      caption: z.string().optional(),
      stepKey: z.string().optional(),
    })
    .nullish(),
});

/** Reads `payloadJson.commentSuppressed`, written when a draft was suppressed. */
export function readCommentSuppressed(
  notification: Pick<UserNotificationContract, "payloadJson">,
): CommentSuppressed | null {
  const parsed = commentSuppressedSchema.safeParse(
    notification.payloadJson?.["commentSuppressed"],
  );
  if (!parsed.success) return null;
  const { reason, artifact } = parsed.data;
  return {
    reason,
    caption: artifact?.caption ?? "",
    stepKey: artifact?.stepKey ?? null,
  };
}

/**
 * "Comment not drafted" notice for a notification whose work item comment was
 * suppressed because a required artifact was unavailable, with a link to the
 * step that should have produced it.
 */
export function CommentSuppressedNotice({
  notification,
}: {
  notification: UserNotificationContract;
}) {
  const projectPath = useProjectPath();
  const suppressed = readCommentSuppressed(notification);
  if (!suppressed) return null;

  const executionId = notification.pipelineExecutionId;
  const stepHref = executionId
    ? suppressed.stepKey
      ? `${projectPath("runs", executionId)}?${new URLSearchParams({ step: suppressed.stepKey }).toString()}`
      : projectPath("runs", executionId)
    : null;
  const subject = suppressed.caption
    ? `“${suppressed.caption}”`
    : "a required artifact";

  return (
    <Alert
      severity="warning"
      action={
        stepHref ? (
          <Button
            component={Link}
            href={stepHref}
            size="small"
            color="inherit"
            endIcon={<OpenInNewIcon fontSize="inherit" />}
          >
            {suppressed.stepKey ? `Step ${suppressed.stepKey}` : "View run"}
          </Button>
        ) : null
      }
    >
      <AlertTitle>Comment not drafted</AlertTitle>
      {`Couldn't include ${subject}: ${humanizeArtifactMarkerReason(suppressed.reason)}.`}
    </Alert>
  );
}
