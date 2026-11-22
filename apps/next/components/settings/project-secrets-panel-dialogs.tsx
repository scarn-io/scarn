"use client";

import { useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from "@mui/material";
import type { ProjectSecretContract } from "@scarn/core/secrets/secret/contracts/project-secret-contracts";
import { NameField, TokenField } from "./api-key-form-shared";

const NAME_HELPER_TEXT =
  "Uppercase letters, digits and underscores, like DATADOG_API_KEY.";

const NAME_PLACEHOLDER = "DATADOG_API_KEY";

/** Decision 7: renaming or deleting is allowed, but environments may still use the old name. */
function StartupWarning({ name }: { name: string }) {
  return (
    <Alert severity="warning">
      Environments that use <code>{name}</code> will fail to start on any worker
      that doesn&apos;t set it in its own <code>.scarn/.env</code>.
    </Alert>
  );
}

type DialogStateProps = {
  isSaving: boolean;
  errorMessage: string | null;
  onClose: () => void;
};

function SecretFormDialog({
  title,
  submitLabel,
  submitColor = "primary",
  canSubmit,
  isSaving,
  errorMessage,
  onClose,
  onSubmit,
  children,
}: DialogStateProps & {
  title: string;
  submitLabel: string;
  submitColor?: "primary" | "error";
  canSubmit: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <form
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onSubmit();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {errorMessage ? (
              <Alert severity="error">{errorMessage}</Alert>
            ) : null}
            {children}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="contained"
            color={submitColor}
            loading={isSaving}
            disabled={!canSubmit}
          >
            {submitLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * The value field is cleared as the request starts, so a value never outlives
 * the request in form state (the same rule as the account API key forms).
 */
export function AddProjectSecretDialog({
  initialName = "",
  onConfirm,
  ...props
}: DialogStateProps & {
  initialName?: string;
  onConfirm: (body: { name: string; value: string }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const canSubmit = name.trim().length > 0 && value.trim().length > 0;

  return (
    <SecretFormDialog
      {...props}
      title="Add secret"
      submitLabel="Save secret"
      canSubmit={canSubmit}
      onSubmit={() => {
        const body = { name: name.trim(), value };
        setValue("");
        onConfirm(body);
      }}
    >
      <NameField
        placeholder={NAME_PLACEHOLDER}
        value={name}
        onChange={setName}
        helperText={NAME_HELPER_TEXT}
        autoFocus
      />
      <TokenField label="Value" value={value} onChange={setValue} />
    </SecretFormDialog>
  );
}

export function ReplaceProjectSecretValueDialog({
  secret,
  onConfirm,
  ...props
}: DialogStateProps & {
  secret: ProjectSecretContract;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <SecretFormDialog
      {...props}
      title={`Replace value of ${secret.name}`}
      submitLabel="Replace value"
      canSubmit={value.trim().length > 0}
      onSubmit={() => {
        const next = value;
        setValue("");
        onConfirm(next);
      }}
    >
      <DialogContentText>
        The current value (ending {secret.lastFour}) is overwritten. Runs that
        start after this use the new value.
      </DialogContentText>
      <TokenField label="New value" value={value} onChange={setValue} />
    </SecretFormDialog>
  );
}

export function RenameProjectSecretDialog({
  secret,
  onConfirm,
  ...props
}: DialogStateProps & {
  secret: ProjectSecretContract;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(secret.name);
  const trimmed = name.trim();

  return (
    <SecretFormDialog
      {...props}
      title={`Rename ${secret.name}`}
      submitLabel="Rename"
      canSubmit={trimmed.length > 0 && trimmed !== secret.name}
      onSubmit={() => {
        onConfirm(trimmed);
      }}
    >
      <StartupWarning name={secret.name} />
      <NameField
        placeholder={NAME_PLACEHOLDER}
        value={name}
        onChange={setName}
        helperText={NAME_HELPER_TEXT}
        autoFocus
      />
    </SecretFormDialog>
  );
}

export function DeleteProjectSecretDialog({
  secret,
  onConfirm,
  ...props
}: DialogStateProps & {
  secret: ProjectSecretContract;
  onConfirm: () => void;
}) {
  return (
    <SecretFormDialog
      {...props}
      title={`Delete ${secret.name}?`}
      submitLabel="Delete"
      submitColor="error"
      canSubmit
      onSubmit={onConfirm}
    >
      <StartupWarning name={secret.name} />
      <DialogContentText>
        The saved value is gone for good. This can&apos;t be undone.
      </DialogContentText>
    </SecretFormDialog>
  );
}
