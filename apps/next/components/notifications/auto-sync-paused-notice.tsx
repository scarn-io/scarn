"use client";

import Link from "next/link";
import { Alert, AlertTitle, Button } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { z } from "zod";
import type { UserNotificationContract } from "@scarn/api/frontend-contracts";
import { useProjectPath } from "@/components/project-route-context";
import {
  autoSyncPausedLine,
  type AutoSyncPausedReason,
} from "@/components/integrations/auto-sync-text";

export const AUTO_SYNC_PAUSED_KIND = "integration_auto_sync_paused";

const PAUSED_REASONS = [
  "key_removed",
  "key_rejected",
  "key_expired",
  "owner_left_project",
  "access_lost",
] as const satisfies readonly AutoSyncPausedReason[];

const autoSyncPausedPayloadSchema = z.object({
  reason: z.enum(PAUSED_REASONS).nullish().catch(null),
  detail: z.string().nullish().catch(null),
});

export type AutoSyncPaused = {
  reason: AutoSyncPausedReason | null;
  detail: string | null;
};

/** Reads an `integration_auto_sync_paused` payload; null for any other kind. */
export function readAutoSyncPaused(
  notification: Pick<UserNotificationContract, "kind" | "payloadJson">,
): AutoSyncPaused | null {
  if (notification.kind !== AUTO_SYNC_PAUSED_KIND) return null;
  const parsed = autoSyncPausedPayloadSchema.safeParse(
    notification.payloadJson ?? {},
  );
  if (!parsed.success) return { reason: null, detail: null };
  const detail = parsed.data.detail?.trim();
  return { reason: parsed.data.reason ?? null, detail: detail || null };
}

/**
 * Body for an "auto-sync paused" notification: why the lent key stopped
 * syncing, the provider's detail if any, and a link to the project's
 * integration settings to pick a new key.
 */
export function AutoSyncPausedNotice({
  notification,
}: {
  notification: UserNotificationContract;
}) {
  const projectPath = useProjectPath();
  const paused = readAutoSyncPaused(notification);
  if (!paused) return null;

  return (
    <Alert
      severity="warning"
      action={
        <Button
          component={Link}
          href={projectPath("settings")}
          size="small"
          color="inherit"
          endIcon={<OpenInNewIcon fontSize="inherit" />}
        >
          Integration settings
        </Button>
      }
    >
      <AlertTitle>{autoSyncPausedLine(paused.reason)}</AlertTitle>
      {paused.detail}
    </Alert>
  );
}
