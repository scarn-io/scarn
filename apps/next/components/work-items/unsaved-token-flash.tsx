"use client";

import { useState } from "react";
import { Alert, Link } from "@mui/material";
import { useSearchParams } from "next/navigation";
import { ACCOUNT_SETTINGS_HREF } from "@/components/integrations/credential-platforms";

/**
 * One-time notice after `/projects/new` connected issue tracking with a token
 * the user chose not to save (`?connectedWithUnsavedToken=1`): every sync and
 * comment approval will ask for a token until one is saved.
 */
export function UnsavedTokenFlash() {
  const searchParams = useSearchParams();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || searchParams.get("connectedWithUnsavedToken") !== "1") {
    return null;
  }

  return (
    <Alert
      severity="info"
      onClose={() => {
        setDismissed(true);
      }}
      sx={{ mb: 2 }}
    >
      Issues are connected with a token Scarn didn&apos;t keep, so you&apos;ll
      be asked for one each time you sync or approve a comment.{" "}
      <Link href={ACCOUNT_SETTINGS_HREF}>Save a token</Link> to pick it from a
      list instead.
    </Alert>
  );
}
