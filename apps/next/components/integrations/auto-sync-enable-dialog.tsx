"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import type { ProjectIntegrationContract } from "@scarn/core/integrations/project-integration/contracts/project-integration-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { AddGitHubTokenForm } from "@/components/settings/add-github-token-form";
import { AddJiraApiKeyForm } from "@/components/settings/add-jira-api-key-form";
import {
  autoSyncConsent,
  autoSyncSecretKind,
  type AutoSyncIntegration,
} from "./auto-sync-text";
import {
  SavedCredentialList,
  useSavedCredentials,
} from "./saved-credential-list";

type AutoSyncEnableDialogProps = {
  open: boolean;
  projectId: string;
  integration: AutoSyncIntegration & { id: string };
  githubAppConfigured: boolean;
  onClose: () => void;
  onEnabled: (integration: ProjectIntegrationContract) => void;
};

/**
 * Picks one of the caller's saved keys of the integration's kind (or adds one),
 * shows the platform's consent text, and lends the key to the integration
 * with `PUT …/auto-sync`.
 */
export function AutoSyncEnableDialog({
  open,
  projectId,
  integration,
  githubAppConfigured,
  onClose,
  onEnabled,
}: AutoSyncEnableDialogProps) {
  const saved = useSavedCredentials(autoSyncSecretKind(integration.kind), open);
  const [error, setError] = useState<string | null>(null);
  const [isEnabling, setIsEnabling] = useState(false);
  const consent = autoSyncConsent(integration, githubAppConfigured);
  const isJira = integration.kind === "jira";
  const keyNoun = isJira ? "Jira API key" : "GitHub token";

  const handleClose = () => {
    setError(null);
    onClose();
  };

  const handleEnable = () => {
    const secretId = saved.selectedKey?.id;
    if (!secretId) return;
    setError(null);
    setIsEnabling(true);
    void getBrowserScarnApiClient()
      .api.projects({ projectId })
      .integrations({ integrationId: integration.id })
      ["auto-sync"].put({ secretId })
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(
            parseApiError(apiError, "Couldn't turn on auto-sync. Try again."),
          );
          return;
        }
        onEnabled(data);
      })
      .catch(() => {
        setError("Couldn't turn on auto-sync. Try again.");
      })
      .finally(() => {
        setIsEnabling(false);
      });
  };

  const addKeyFormProps = {
    onCreated: saved.addKey,
    onError: setError,
    onSubmitStart: () => {
      setError(null);
    },
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Turn on auto-sync</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2">{consent.text}</Typography>
          {consent.appHint ? (
            <Alert severity="info">{consent.appHint}</Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          <SavedCredentialList
            state={saved.state}
            selected={saved.selected}
            onSelect={saved.setSelected}
            label={`Your ${keyNoun}`}
            newOptionLabel={`Add a ${keyNoun}`}
            failedMessage={`Couldn't load your saved keys. You can add a ${keyNoun} instead.`}
          />
          {saved.state.status !== "loading" && saved.isNew ? (
            isJira ? (
              <AddJiraApiKeyForm {...addKeyFormProps} />
            ) : (
              <AddGitHubTokenForm {...addKeyFormProps} />
            )
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleEnable}
          loading={isEnabling}
          disabled={saved.selectedKey === undefined}
        >
          Turn on auto-sync
        </Button>
      </DialogActions>
    </Dialog>
  );
}
