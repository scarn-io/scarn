"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Alert, Stack, Typography } from "@mui/material";
import type {
  ManagedConnectionContract,
  ManagedConnectionPresetContract,
  ManagedOAuthCallbackError,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { useHasProjectPermission } from "@/components/project-route-context";
import { redirectToUrl } from "./full-page-redirect";
import { managedOAuthCallbackErrorMessage } from "./project-mcp-connection-messages";
import {
  ProjectMcpConnectionCard,
  type Flash,
} from "./project-mcp-connection-card";
import { AddConnectionMenu } from "./project-mcp-connections-add-menu";
import { StartConnectionDialog } from "./project-mcp-connections-dialogs";

/**
 * The presets that would add a new connection: those no existing connection
 * was created from or already points at. A disconnected connection still
 * counts; its own card connects it again.
 */
const addablePresets = (
  presets: ManagedConnectionPresetContract[],
  connections: ManagedConnectionContract[],
): ManagedConnectionPresetContract[] =>
  presets.filter(
    (preset) =>
      !connections.some(
        (connection) =>
          connection.preset === preset.key ||
          connection.resource === preset.resource,
      ),
  );

/**
 * Project settings "MCP connections": one card per managed MCP connection,
 * plus an "Add connection" menu of presets not yet connected. Admins
 * (`secrets:write`) add, connect, confirm, reconnect and disconnect; other
 * members see the status read-only. No token ever reaches this component.
 *
 * `callbackError` is the safe code the OAuth callback put on `?error=`.
 */
export function ProjectMcpConnectionsPanel({
  projectId,
  initialConnections,
  presets,
  callbackError,
}: {
  projectId: string;
  initialConnections: ManagedConnectionContract[];
  presets: ManagedConnectionPresetContract[];
  callbackError: ManagedOAuthCallbackError | null;
}) {
  const canManage = useHasProjectPermission("secrets:write");
  const canListTools = useHasProjectPermission("executions:write");
  const router = useRouter();
  const pathname = usePathname();
  const [connections, setConnections] = useState(initialConnections);
  const [adding, setAdding] = useState<ManagedConnectionPresetContract | null>(
    null,
  );
  const [isStarting, setIsStarting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(
    callbackError
      ? {
          severity: "error",
          text: managedOAuthCallbackErrorMessage(callbackError),
        }
      : null,
  );

  const clearCallbackParams = () => {
    router.replace(pathname, { scroll: false });
  };

  const reload = useCallback(async () => {
    const { data } = await getBrowserScarnApiClient()
      .api.projects({ projectId })
      ["mcp-connections"].get();
    if (Array.isArray(data)) {
      setConnections(data);
    }
  }, [projectId]);

  const replaceConnection = (next: ManagedConnectionContract) => {
    setConnections((current) =>
      current.map((connection) =>
        connection.id === next.id ? next : connection,
      ),
    );
  };

  const startAdding = (preset: ManagedConnectionPresetContract) => {
    setAddError(null);
    setFlash(null);
    setAdding(preset);
  };

  const closeAdding = () => {
    if (isStarting) return;
    setAdding(null);
    setAddError(null);
  };

  const handleAdd = (preset: ManagedConnectionPresetContract) => {
    const fallback = `Couldn't start connecting to ${preset.label}.`;
    setAddError(null);
    setIsStarting(true);
    void getBrowserScarnApiClient()
      .api.projects({ projectId })
      ["mcp-connections"].post({ preset: preset.key })
      .then(({ data, error }) => {
        if (error) {
          setIsStarting(false);
          setAddError(parseApiError(error, fallback));
          return;
        }
        redirectToUrl(data.authorizationUrl);
      })
      .catch(() => {
        setIsStarting(false);
        setAddError(fallback);
      });
  };

  const addable = addablePresets(presets, connections);

  return (
    <Stack spacing={2}>
      {flash ? (
        <Alert
          severity={flash.severity}
          onClose={() => {
            setFlash(null);
            if (callbackError) clearCallbackParams();
          }}
        >
          {flash.text}
        </Alert>
      ) : null}

      {!canManage ? (
        <Alert severity="info">
          Only project admins can add, reconnect or disconnect connections.
        </Alert>
      ) : null}

      {connections.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          This project has no connections yet.
        </Typography>
      ) : null}

      {connections.map((connection) => (
        <ProjectMcpConnectionCard
          key={connection.id}
          projectId={projectId}
          connection={connection}
          removalUrl={
            presets.find((preset) => preset.key === connection.preset)
              ?.removalUrl ?? null
          }
          canManage={canManage}
          canListTools={canListTools}
          onChange={replaceConnection}
          reload={reload}
          onFlash={setFlash}
          onSettled={clearCallbackParams}
        />
      ))}

      {canManage && addable.length > 0 ? (
        <AddConnectionMenu presets={addable} onSelect={startAdding} />
      ) : null}

      {adding ? (
        <StartConnectionDialog
          label={adding.label}
          kind="connect"
          isSaving={isStarting}
          errorMessage={addError}
          onClose={closeAdding}
          onConfirm={() => {
            handleAdd(adding);
          }}
        />
      ) : null}
    </Stack>
  );
}
