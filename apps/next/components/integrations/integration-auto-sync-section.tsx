"use client";

import { useState } from "react";
import { Alert, Button, Stack, Typography } from "@mui/material";
import type {
  ProjectIntegrationAutoSyncContract,
  ProjectIntegrationContract,
} from "@scarn/core/integrations/project-integration/contracts/project-integration-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { AutoSyncEnableDialog } from "./auto-sync-enable-dialog";
import {
  autoSyncOnLine,
  autoSyncPausedLine,
  type AutoSyncIntegration,
} from "./auto-sync-text";

export type AutoSyncSectionIntegration = AutoSyncIntegration & {
  id: string;
  lastSyncedAt: string | null;
  autoSync: ProjectIntegrationAutoSyncContract;
};

/**
 * Auto-sync status for a Jira or GitHub token integration, plus the controls
 * to turn it on, take it over with your own key, or turn it off. Members who
 * can't manage the integration see only the status.
 */
export function IntegrationAutoSyncSection({
  projectId,
  integration,
  githubAppConfigured,
  canManage,
  onIntegrationChange,
}: {
  projectId: string;
  integration: AutoSyncSectionIntegration;
  githubAppConfigured: boolean;
  canManage: boolean;
  onIntegrationChange: (integration: ProjectIntegrationContract) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isTurningOff, setIsTurningOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { autoSync } = integration;

  if (!autoSync.supported) return null;

  const handleTurnOff = () => {
    setError(null);
    setIsTurningOff(true);
    void getBrowserScarnApiClient()
      .api.projects({ projectId })
      .integrations({ integrationId: integration.id })
      ["auto-sync"].delete()
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(
            parseApiError(apiError, "Couldn't turn off auto-sync. Try again."),
          );
          return;
        }
        onIntegrationChange(data);
      })
      .catch(() => {
        setError("Couldn't turn off auto-sync. Try again.");
      })
      .finally(() => {
        setIsTurningOff(false);
      });
  };

  const openDialog = () => {
    setError(null);
    setDialogOpen(true);
  };

  return (
    <Stack spacing={0.75} aria-label="Auto-sync" role="group">
      {autoSync.state === "on" ? (
        <Typography variant="body2">
          {autoSyncOnLine(autoSync.syncsAs, integration.lastSyncedAt)}
        </Typography>
      ) : autoSync.state === "paused" ? (
        <Alert severity="warning">
          <Typography variant="body2">
            {autoSyncPausedLine(autoSync.pausedReason)}
            {canManage ? " Turn it back on with your key." : null}
          </Typography>
          {autoSync.pausedDetail ? (
            <Typography variant="caption">{autoSync.pausedDetail}</Typography>
          ) : null}
        </Alert>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Auto-sync off
        </Typography>
      )}
      {error ? <Alert severity="error">{error}</Alert> : null}
      {canManage ? (
        <Stack direction="row" spacing={1}>
          {autoSync.state === "on" ? (
            <>
              <Button size="small" variant="outlined" onClick={openDialog}>
                Use my key instead
              </Button>
              <Button
                size="small"
                onClick={handleTurnOff}
                loading={isTurningOff}
              >
                Turn off auto-sync
              </Button>
            </>
          ) : (
            <Button size="small" variant="outlined" onClick={openDialog}>
              {autoSync.state === "paused"
                ? "Turn back on with my key"
                : "Turn on auto-sync"}
            </Button>
          )}
        </Stack>
      ) : null}
      {canManage ? (
        <AutoSyncEnableDialog
          open={dialogOpen}
          projectId={projectId}
          integration={integration}
          githubAppConfigured={githubAppConfigured}
          onClose={() => {
            setDialogOpen(false);
          }}
          onEnabled={(updated) => {
            setDialogOpen(false);
            onIntegrationChange(updated);
          }}
        />
      ) : null}
    </Stack>
  );
}
