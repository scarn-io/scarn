"use client";

import { useState } from "react";
import { Alert } from "@mui/material";
import { useSearchParams } from "next/navigation";

/**
 * Non-blocking flash shown on arrival at the work-items page when
 * `/projects/new`'s create-from-repo flow (Phase 4c) created the project
 * successfully but the initial issue sync failed (`?syncFailed=1`). The
 * project itself is fine — this just points at the fix.
 */
export function SyncFailedFlash() {
  const searchParams = useSearchParams();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || searchParams.get("syncFailed") !== "1") return null;

  return (
    <Alert
      severity="warning"
      onClose={() => {
        setDismissed(true);
      }}
      sx={{ mb: 2 }}
    >
      Repo linked, but the first sync failed — try Sync now in Settings.
    </Alert>
  );
}
