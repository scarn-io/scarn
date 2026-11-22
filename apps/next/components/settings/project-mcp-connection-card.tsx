"use client";

import { useCallback, useState } from "react";
import { Alert, Stack } from "@mui/material";
import type {
  DisconnectManagedConnectionResponse,
  ManagedConnectionContract,
} from "@scarn/api/frontend-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorStatus, parseApiError } from "@/app/_lib/api-error";
import { redirectToUrl } from "./full-page-redirect";
import {
  ConfirmCandidateCard,
  ConnectionStatusCard,
} from "./project-mcp-connection-cards";
import {
  DisconnectConnectionDialog,
  StartConnectionDialog,
} from "./project-mcp-connections-dialogs";
import { ProjectMcpConnectionTools } from "./project-mcp-connection-tools";

export type Flash = { severity: "success" | "info" | "error"; text: string };

type OpenDialog =
  | { kind: "start"; mode: "connect" | "reconnect" }
  | { kind: "disconnect"; result: DisconnectManagedConnectionResponse | null };

/**
 * One managed MCP connection in project settings: its status card, its
 * pending candidate and its connect, reconnect and disconnect dialogs. Every
 * request it sends names this connection only; `onChange` hands the panel the
 * connection as the API last returned it.
 */
export function ProjectMcpConnectionCard({
  projectId,
  connection,
  removalUrl,
  canManage,
  canListTools,
  onChange,
  reload,
  onFlash,
  onSettled,
}: {
  projectId: string;
  connection: ManagedConnectionContract;
  /** Where to remove Scarn's access on the service's side, from the connection's preset. */
  removalUrl: string | null;
  canManage: boolean;
  canListTools: boolean;
  onChange: (connection: ManagedConnectionContract) => void;
  reload: () => Promise<void>;
  onFlash: (flash: Flash | null) => void;
  /** Called once a confirm, cancel or disconnect went through, to drop the callback's query string. */
  onSettled: () => void;
}) {
  const { label } = connection;
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const connectionApi = () =>
    getBrowserScarnApiClient()
      .api.projects({ projectId })
      ["mcp-connections"]({ connectionId: parseUuidV7(connection.id) });

  const reloadQuietly = useCallback(() => {
    reload().catch(() => undefined);
  }, [reload]);

  const openDialog = (next: OpenDialog) => {
    setDialogError(null);
    onFlash(null);
    setDialog(next);
  };

  const closeDialog = () => {
    if (isSaving) return;
    if (dialog?.kind === "disconnect" && dialog.result) {
      onChange(dialog.result.connection);
    }
    setDialog(null);
    setDialogError(null);
  };

  const handleStart = (mode: "connect" | "reconnect") => {
    const fallback = `Couldn't start connecting to ${label}.`;
    const { preset, name } = connection;
    if (mode === "connect" && preset === null) return;
    setDialogError(null);
    setIsSaving(true);
    const request =
      mode === "connect" && preset !== null
        ? getBrowserScarnApiClient()
            .api.projects({ projectId })
            ["mcp-connections"].post({ preset, name })
        : connectionApi().reconnect.post();
    void request
      .then(({ data, error }) => {
        if (error) {
          setIsSaving(false);
          setDialogError(parseApiError(error, fallback));
          return;
        }
        redirectToUrl(data.authorizationUrl);
      })
      .catch(() => {
        setIsSaving(false);
        setDialogError(fallback);
      });
  };

  const handleCandidate = (action: "confirm" | "cancel") => {
    const candidate = connection.candidate;
    if (!candidate) return;
    setConfirmError(null);
    setIsSaving(true);
    const route = connectionApi().candidate;
    const request =
      action === "confirm"
        ? route.confirm.post({
            candidateId: parseUuidV7(candidate.id),
            fingerprint: candidate.fingerprint,
            expectedVersion: connection.version,
          })
        : route.cancel.post({ candidateId: parseUuidV7(candidate.id) });
    const fallback =
      action === "confirm"
        ? "Couldn't confirm the connection. Try again."
        : "Couldn't cancel the connection. Try again.";
    void request
      .then(async ({ data, error }) => {
        if (error) {
          setConfirmError(parseApiError(error, fallback));
          const status = apiErrorStatus(error);
          if (status === 404 || status === 409) {
            await reload();
          }
          return;
        }
        onChange(data);
        onFlash(
          action === "confirm"
            ? {
                severity: "success",
                text: `${label} connected. Steps in this project can now use it.`,
              }
            : {
                severity: "info",
                text: connection.account
                  ? "Cancelled. The current connection keeps working."
                  : "Cancelled. Nothing was connected.",
              },
        );
        onSettled();
      })
      .catch(() => {
        setConfirmError(fallback);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  const handleDisconnect = () => {
    const fallback = `Couldn't disconnect ${label}. Try again.`;
    setDialogError(null);
    setIsSaving(true);
    void connectionApi()
      .delete()
      .then(({ data, error }) => {
        if (error) {
          setDialogError(parseApiError(error, fallback));
          return;
        }
        setDialog({ kind: "disconnect", result: data });
        onSettled();
      })
      .catch(() => {
        setDialogError(fallback);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  const candidate = connection.candidate;
  const isServing =
    connection.state === "ready" ||
    connection.state === "ready_with_pending_reconnect";

  return (
    <Stack spacing={2}>
      <ConnectionStatusCard
        connection={connection}
        removalUrl={removalUrl}
        canManage={canManage}
        tools={
          isServing && canListTools ? (
            <ProjectMcpConnectionTools
              key={`${connection.id}:${String(connection.generation)}`}
              projectId={projectId}
              connectionId={connection.id}
              label={label}
              onNotReady={reloadQuietly}
            />
          ) : null
        }
        onConnect={
          connection.preset === null
            ? null
            : () => {
                openDialog({ kind: "start", mode: "connect" });
              }
        }
        onReconnect={() => {
          openDialog({ kind: "start", mode: "reconnect" });
        }}
        onDisconnect={() => {
          openDialog({ kind: "disconnect", result: null });
        }}
      />

      {candidate ? (
        canManage ? (
          <ConfirmCandidateCard
            projectId={projectId}
            connection={connection}
            candidate={candidate}
            isSaving={isSaving}
            errorMessage={confirmError}
            onConfirm={() => {
              handleCandidate("confirm");
            }}
            onCancel={() => {
              handleCandidate("cancel");
            }}
          />
        ) : (
          <Alert severity="info">
            A new {label} connection is waiting for a project admin to confirm
            it.
          </Alert>
        )
      ) : null}

      {dialog?.kind === "start" ? (
        <StartConnectionDialog
          label={label}
          kind={dialog.mode}
          isSaving={isSaving}
          errorMessage={dialogError}
          onClose={closeDialog}
          onConfirm={() => {
            handleStart(dialog.mode);
          }}
        />
      ) : null}
      {dialog?.kind === "disconnect" ? (
        <DisconnectConnectionDialog
          projectId={projectId}
          connection={connection}
          result={dialog.result}
          isSaving={isSaving}
          errorMessage={dialogError}
          onClose={closeDialog}
          onConfirm={handleDisconnect}
        />
      ) : null}
    </Stack>
  );
}
