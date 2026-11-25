"use client";

import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";
import type { SecretContract } from "@scarn/core/secrets/secret/contracts/secret-contracts";

export function RenameApiKeyDialog({
  apiKey,
  isSaving,
  onClose,
  onConfirm,
}: {
  apiKey: SecretContract | null;
  isSaving: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  return (
    <Dialog open={apiKey !== null} onClose={onClose} maxWidth="xs" fullWidth>
      {apiKey ? (
        <RenameApiKeyForm
          key={apiKey.id}
          initialName={apiKey.name}
          isSaving={isSaving}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      ) : null}
    </Dialog>
  );
}

function RenameApiKeyForm({
  initialName,
  isSaving,
  onClose,
  onConfirm,
}: {
  initialName: string;
  isSaving: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const canSave = name.trim().length > 0;
  const submit = () => {
    if (canSave) onConfirm(name.trim());
  };

  return (
    <>
      <DialogTitle>Rename API key</DialogTitle>
      <DialogContent>
        <Stack sx={{ pt: 1 }}>
          <TextField
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            size="small"
            fullWidth
            autoFocus
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={submit}
          loading={isSaving}
          disabled={!canSave}
        >
          Save
        </Button>
      </DialogActions>
    </>
  );
}

export function DeleteApiKeyDialog({
  apiKey,
  isDeleting,
  onClose,
  onConfirm,
}: {
  apiKey: SecretContract | null;
  isDeleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={apiKey !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {apiKey ? `Delete "${apiKey.name}"?` : "Delete API key?"}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          You won&apos;t be able to pick this key for Jira syncs or comments any
          more. This can&apos;t be undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          color="error"
          onClick={onConfirm}
          loading={isDeleting}
        >
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}
