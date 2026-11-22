"use client";

/**
 * Saves a new project secret from the start dialog, so an extra connector's
 * var can use a secret that isn't in Scarn yet without leaving the dialog.
 */
import { useState } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { AddProjectSecretDialog } from "@/components/settings/project-secrets-panel-dialogs";

const FALLBACK_ERROR = "Couldn't save that secret. Try again.";

export function StartTaskAddSecretDialog({
  projectId,
  initialName,
  onClose,
  onSaved,
}: {
  projectId: string;
  initialName: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const save = (body: { name: string; value: string }) => {
    setErrorMessage(null);
    setIsSaving(true);
    void getBrowserScarnApiClient()
      .api.projects({ projectId: parseUuidV7(projectId) })
      .secrets.post(body)
      .then(({ data, error }) => {
        if (error) {
          setErrorMessage(parseApiError(error, FALLBACK_ERROR));
          return;
        }
        onSaved(data.name);
      })
      .catch(() => {
        setErrorMessage(FALLBACK_ERROR);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  return (
    <AddProjectSecretDialog
      initialName={initialName}
      isSaving={isSaving}
      errorMessage={errorMessage}
      onClose={onClose}
      onConfirm={save}
    />
  );
}
