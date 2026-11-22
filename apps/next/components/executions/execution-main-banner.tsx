"use client";

import { Alert, Button } from "@mui/material";
import type { ReactNode } from "react";
import { ExecutionMobileStepsPanel } from "./execution-mobile-steps-panel";

/**
 * Shown above the main content: the mobile steps panel, page alerts, and,
 * when a failed run ended through a route a person may overrule, an offer to
 * overrule it.
 */
export function ExecutionMainBanner({
  mobileNavOpen,
  onToggleMobileNav,
  selectionLabel,
  stepsNav,
  error,
  failedOverrule,
}: {
  mobileNavOpen: boolean;
  onToggleMobileNav: () => void;
  selectionLabel: string;
  stepsNav: ReactNode;
  error: string;
  /** The fail node the run ended at, and how to open the Overrule dialog. */
  failedOverrule: { endTitle: string; onOverrule: () => void } | null;
}) {
  return (
    <>
      <ExecutionMobileStepsPanel
        open={mobileNavOpen}
        onToggle={onToggleMobileNav}
        selectionLabel={selectionLabel}
      >
        {stepsNav}
      </ExecutionMobileStepsPanel>
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      ) : null}
      {failedOverrule ? (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={failedOverrule.onOverrule}
            >
              Overrule…
            </Button>
          }
        >
          Ended at {failedOverrule.endTitle} by rule.
        </Alert>
      ) : null}
    </>
  );
}
