"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import KeyIcon from "@mui/icons-material/Key";
import type { ProjectSecretContract } from "@scarn/core/secrets/secret/contracts/project-secret-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorStatus, parseApiError } from "@/app/_lib/api-error";
import { useHasProjectPermission } from "@/components/project-route-context";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@/components/work-items/comment-presentation";
import {
  AddProjectSecretDialog,
  DeleteProjectSecretDialog,
  RenameProjectSecretDialog,
  ReplaceProjectSecretValueDialog,
} from "./project-secrets-panel-dialogs";

type OpenDialog =
  | { kind: "add" }
  | { kind: "replace" | "rename" | "delete"; secret: ProjectSecretContract };

const GONE_MESSAGE = "That secret no longer exists. It may have been deleted.";

function RelativeTime({ iso }: { iso: string }) {
  return (
    <Tooltip title={formatAbsoluteTime(iso)}>
      <span>{formatRelativeTime(iso)}</span>
    </Tooltip>
  );
}

/**
 * Project settings "Secrets": named values the project's environments
 * reference by name. Values are write-only — the table only ever shows the
 * last four characters. Members without `secrets:write` see a read-only list.
 */
export function ProjectSecretsPanel({
  projectId,
  initialSecrets,
}: {
  projectId: string;
  initialSecrets: ProjectSecretContract[];
}) {
  const canManage = useHasProjectPermission("secrets:write");
  const [secrets, setSecrets] = useState(initialSecrets);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const open = (next: OpenDialog) => {
    setDialogError(null);
    setSuccessMessage(null);
    setDialog(next);
  };

  const close = () => {
    if (isSaving) return;
    setDialog(null);
    setDialogError(null);
  };

  const secretsApi = () =>
    getBrowserScarnApiClient().api.projects({ projectId }).secrets;

  /**
   * Runs one write, keeping the dialog open with the API's message on
   * failure. A 404 means someone else deleted it, so it leaves the table.
   */
  const run = <T,>(
    request: () => Promise<{ data: T | null; error: unknown }>,
    fallback: string,
    onSuccess: (data: T) => void,
    targetId?: string,
  ) => {
    setDialogError(null);
    setIsSaving(true);
    void request()
      .then(({ data, error }) => {
        if (error || data === null) {
          if (targetId && apiErrorStatus(error) === 404) {
            setSecrets((current) =>
              current.filter((secret) => secret.id !== targetId),
            );
            setDialogError(GONE_MESSAGE);
            return;
          }
          setDialogError(parseApiError(error, fallback));
          return;
        }
        onSuccess(data);
        setDialog(null);
      })
      .catch(() => {
        setDialogError(fallback);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  const replaceInList = (updated: ProjectSecretContract) => {
    setSecrets((current) =>
      current.map((secret) => (secret.id === updated.id ? updated : secret)),
    );
  };

  const handleAdd = (body: { name: string; value: string }) => {
    run(
      () => secretsApi().post(body),
      "Couldn't save that secret. Try again.",
      (created) => {
        setSecrets((current) => [created, ...current]);
        setSuccessMessage(`Saved ${created.name}.`);
      },
    );
  };

  const handleUpdate = (
    target: ProjectSecretContract,
    body: { name: string } | { value: string },
    fallback: string,
    success: (updated: ProjectSecretContract) => string,
  ) => {
    run(
      () =>
        getBrowserScarnApiClient()
          .api.projects({ projectId })
          .secrets({ secretId: parseUuidV7(target.id) })
          .patch(body),
      fallback,
      (updated) => {
        replaceInList(updated);
        setSuccessMessage(success(updated));
      },
      target.id,
    );
  };

  const handleDelete = (target: ProjectSecretContract) => {
    run(
      () =>
        getBrowserScarnApiClient()
          .api.projects({ projectId })
          .secrets({ secretId: parseUuidV7(target.id) })
          .delete(),
      "Couldn't delete that secret. Try again.",
      () => {
        setSecrets((current) =>
          current.filter((secret) => secret.id !== target.id),
        );
        setSuccessMessage(`Deleted ${target.name}.`);
      },
      target.id,
    );
  };

  return (
    <Stack spacing={2}>
      {successMessage ? (
        <Alert severity="success">{successMessage}</Alert>
      ) : null}

      {canManage ? (
        <Stack direction="row" justifyContent="flex-end">
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              open({ kind: "add" });
            }}
          >
            Add secret
          </Button>
        </Stack>
      ) : (
        <Alert severity="info">
          Only project admins can add, change or delete secrets.
        </Alert>
      )}

      {secrets.length === 0 ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="body2">No secrets yet.</Typography>
          </CardContent>
        </Card>
      ) : (
        <TableContainer component={Card} variant="outlined">
          <Table size="small" aria-label="Project secrets">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Value</TableCell>
                <TableCell>Updated</TableCell>
                <TableCell>Last used</TableCell>
                {canManage ? (
                  <TableCell align="right">Actions</TableCell>
                ) : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {secrets.map((secret) => (
                <TableRow key={secret.id} aria-label={`Secret ${secret.name}`}>
                  <TableCell>
                    <Typography variant="body2" fontFamily="monospace">
                      {secret.name}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      fontFamily="monospace"
                    >
                      ••••{secret.lastFour}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {secret.updatedBy?.username
                        ? `${secret.updatedBy.username}, `
                        : ""}
                      <RelativeTime iso={secret.updatedAt} />
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {secret.lastUsedAt ? (
                        <RelativeTime iso={secret.lastUsedAt} />
                      ) : (
                        "Never"
                      )}
                    </Typography>
                  </TableCell>
                  {canManage ? (
                    <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                      <Tooltip title="Replace value">
                        <IconButton
                          size="small"
                          aria-label={`Replace value of ${secret.name}`}
                          onClick={() => {
                            open({ kind: "replace", secret });
                          }}
                        >
                          <KeyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Rename">
                        <IconButton
                          size="small"
                          aria-label={`Rename ${secret.name}`}
                          onClick={() => {
                            open({ kind: "rename", secret });
                          }}
                        >
                          <DriveFileRenameOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton
                          size="small"
                          color="error"
                          aria-label={`Delete ${secret.name}`}
                          onClick={() => {
                            open({ kind: "delete", secret });
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {dialog?.kind === "add" ? (
        <AddProjectSecretDialog
          isSaving={isSaving}
          errorMessage={dialogError}
          onClose={close}
          onConfirm={handleAdd}
        />
      ) : null}
      {dialog?.kind === "replace" ? (
        <ReplaceProjectSecretValueDialog
          key={dialog.secret.id}
          secret={dialog.secret}
          isSaving={isSaving}
          errorMessage={dialogError}
          onClose={close}
          onConfirm={(value) => {
            handleUpdate(
              dialog.secret,
              { value },
              "Couldn't replace that value. Try again.",
              (updated) => `Replaced the value of ${updated.name}.`,
            );
          }}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameProjectSecretDialog
          key={dialog.secret.id}
          secret={dialog.secret}
          isSaving={isSaving}
          errorMessage={dialogError}
          onClose={close}
          onConfirm={(name) => {
            handleUpdate(
              dialog.secret,
              { name },
              "Couldn't rename that secret. Try again.",
              (updated) => `Renamed ${dialog.secret.name} to ${updated.name}.`,
            );
          }}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteProjectSecretDialog
          key={dialog.secret.id}
          secret={dialog.secret}
          isSaving={isSaving}
          errorMessage={dialogError}
          onClose={close}
          onConfirm={() => {
            handleDelete(dialog.secret);
          }}
        />
      ) : null}
    </Stack>
  );
}
