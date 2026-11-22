"use client";

import type { ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import type {
  ManagedConnectionAccountContract,
  ManagedConnectionCandidateContract,
  ManagedConnectionContract,
} from "@scarn/api/frontend-contracts";
import { ProjectMcpConnectionUsage } from "./project-mcp-connection-usage";
import {
  STATE_LABELS,
  cliReconnectCommand,
  managedConnectionAccountLine,
  managedConnectionReasonMessage,
  revocationMessage,
  sharedAuthorityDisclosure,
} from "./project-mcp-connection-messages";
import { ProviderRemovalLink } from "./project-mcp-connections-dialogs";

const STATE_COLORS: Record<
  ManagedConnectionContract["state"],
  "default" | "success" | "warning" | "error" | "info"
> = {
  disconnected: "default",
  connecting: "info",
  awaiting_confirmation: "warning",
  ready: "success",
  ready_with_pending_reconnect: "success",
  reconnect_required: "error",
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

const accountsDiffer = (
  a: ManagedConnectionAccountContract,
  b: ManagedConnectionAccountContract,
) => a.userName !== b.userName || a.workspaceName !== b.workspaceName;

function ScopeChips({ scopes, label }: { scopes: string[]; label: string }) {
  if (scopes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {label} didn&apos;t list any permissions.
      </Typography>
    );
  }
  return (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
      {scopes.map((scope) => (
        <Chip key={scope} size="small" variant="outlined" label={scope} />
      ))}
    </Stack>
  );
}

function IdentityNotice({
  label,
  candidate,
  active,
}: {
  label: string;
  candidate: ManagedConnectionCandidateContract;
  active: ManagedConnectionAccountContract | null;
}) {
  if (active) {
    if (candidate.sameIdentityAsActive === "unknown") {
      return (
        <Alert severity="warning">
          Scarn can&apos;t verify this is the same account as the current
          connection.
        </Alert>
      );
    }
    if (!candidate.sameIdentityAsActive) {
      return (
        <Alert severity="warning">
          This is a different {label} account from the current connection.
        </Alert>
      );
    }
    return (
      <Alert severity="info">
        This is the same {label} account as the current connection.
      </Alert>
    );
  }
  if (!candidate.account.identityVerified) {
    return (
      <Alert severity="warning">
        {label} didn&apos;t fully identify this account, so Scarn can&apos;t
        verify which account it is.
      </Alert>
    );
  }
  return null;
}

function ReconnectChanges({
  label,
  candidate,
  activeAccount,
  activeScopes,
}: {
  label: string;
  candidate: ManagedConnectionCandidateContract;
  activeAccount: ManagedConnectionAccountContract;
  activeScopes: string[];
}) {
  const added = candidate.grantedScopes.filter(
    (scope) => !activeScopes.includes(scope),
  );
  const removed = activeScopes.filter(
    (scope) => !candidate.grantedScopes.includes(scope),
  );
  const accountChanged = accountsDiffer(candidate.account, activeAccount);
  if (!accountChanged && added.length === 0 && removed.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Same account name and permissions as the current connection.
      </Typography>
    );
  }
  return (
    <Stack spacing={0.5} aria-label="Changes from the current connection">
      <Typography variant="subtitle2">
        Changes from the current connection
      </Typography>
      {accountChanged ? (
        <Typography variant="body2">
          Was: {managedConnectionAccountLine(activeAccount, label)}
        </Typography>
      ) : null}
      {added.length > 0 ? (
        <Typography variant="body2">
          Adds permissions: {added.join(", ")}
        </Typography>
      ) : null}
      {removed.length > 0 ? (
        <Typography variant="body2">
          Removes permissions: {removed.join(", ")}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * The candidate a callback stored, waiting for an admin to confirm it
 * (decision 4). Shows the shared-authority disclosure again, the candidate's
 * account and scopes and, on reconnect, what changed from the active grant.
 */
export function ConfirmCandidateCard({
  projectId,
  connection,
  candidate,
  isSaving,
  errorMessage,
  onConfirm,
  onCancel,
}: {
  projectId: string;
  connection: ManagedConnectionContract;
  candidate: ManagedConnectionCandidateContract;
  isSaving: boolean;
  errorMessage: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const active = connection.account;
  const { label } = connection;
  return (
    <Card
      component="section"
      variant="outlined"
      aria-label={`Confirm ${label} connection`}
    >
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="subtitle1" fontWeight={600}>
            {active
              ? `Confirm the new ${label} connection`
              : `Confirm the ${label} connection`}
          </Typography>
          {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
          <Alert severity="warning">{sharedAuthorityDisclosure(label)}</Alert>
          <Typography variant="body2">
            {managedConnectionAccountLine(candidate.account, label)}
          </Typography>
          <IdentityNotice label={label} candidate={candidate} active={active} />
          <Stack spacing={1}>
            <Typography variant="subtitle2">Permissions granted</Typography>
            <ScopeChips scopes={candidate.grantedScopes} label={label} />
          </Stack>
          {active ? (
            <ReconnectChanges
              label={label}
              candidate={candidate}
              activeAccount={active}
              activeScopes={connection.grantedScopes}
            />
          ) : null}
          {active ? (
            <ProjectMcpConnectionUsage
              key={`${connection.id}:${String(connection.version)}`}
              projectId={projectId}
              connectionId={connection.id}
            />
          ) : null}
          <Typography variant="body2" color="text.secondary">
            Confirm before {new Date(candidate.expiresAt).toLocaleTimeString()},
            or connect again.
            {active
              ? " Until you confirm, the current connection keeps working."
              : null}
          </Typography>
        </Stack>
      </CardContent>
      <CardActions sx={{ justifyContent: "flex-end", px: 2, pb: 2 }}>
        <Button onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button variant="contained" loading={isSaving} onClick={onConfirm}>
          Confirm
        </Button>
      </CardActions>
    </Card>
  );
}

/**
 * Where a custom connection (no preset) signs in: its authorization server,
 * and that it was connected from the CLI. One with a supplied client can
 * only be signed in again from the CLI (decision 13), so it names the command.
 */
function CustomConnectionDetails({
  connection,
}: {
  connection: ManagedConnectionContract;
}) {
  if (connection.preset !== null) return null;
  return (
    <>
      <Typography variant="body2" color="text.secondary">
        Connected from the CLI · Signs in with {connection.issuerOrigin}
      </Typography>
      {connection.suppliedClient !== null ? (
        <Typography variant="body2" color="text.secondary">
          Reconnect from the CLI:{" "}
          <code>{cliReconnectCommand(connection.name)}</code>
        </Typography>
      ) : null}
    </>
  );
}

/**
 * One connection's status and actions. `onConnect` is null when the
 * connection can't be started again from settings (it has no preset);
 * `removalUrl` is its preset's removal page, shown with its revocation
 * history. A connection with a supplied client has no browser reconnect.
 */
export function ConnectionStatusCard({
  connection,
  removalUrl,
  canManage,
  tools,
  onConnect,
  onReconnect,
  onDisconnect,
}: {
  connection: ManagedConnectionContract;
  removalUrl: string | null;
  canManage: boolean;
  tools?: ReactNode;
  onConnect: (() => void) | null;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const { label, state } = connection;
  const reason = managedConnectionReasonMessage(connection.reasonCode, label);
  const canConnect =
    onConnect !== null && (state === "disconnected" || state === "connecting");
  const canReconnect =
    connection.suppliedClient === null &&
    (state === "ready" || state === "reconnect_required") &&
    connection.candidate === null;
  const canDisconnect = state !== "disconnected";
  const lastRevocation =
    state === "disconnected" ? connection.lastRevocation : null;
  const revocation = lastRevocation
    ? revocationMessage(lastRevocation.outcome, label)
    : null;

  return (
    <Card
      component="section"
      variant="outlined"
      aria-label={`${label} connection`}
    >
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle1" fontWeight={600}>
              {label}
            </Typography>
            <Chip
              size="small"
              label={STATE_LABELS[state]}
              color={STATE_COLORS[state]}
            />
          </Stack>
          {reason ? (
            <Typography variant="body2" color="text.secondary">
              {reason}
            </Typography>
          ) : null}
          <CustomConnectionDetails connection={connection} />
          {connection.account ? (
            <>
              <Typography variant="body2">
                {managedConnectionAccountLine(connection.account, label)}
              </Typography>
              {!connection.account.identityVerified ? (
                <Typography variant="body2" color="text.secondary">
                  {label} didn&apos;t fully identify this account.
                </Typography>
              ) : null}
              <ScopeChips scopes={connection.grantedScopes} label={label} />
            </>
          ) : state === "disconnected" ? (
            <Typography variant="body2" color="text.secondary">
              No {label} account is connected.
            </Typography>
          ) : null}
          {lastRevocation && revocation ? (
            <Alert severity={revocation.severity}>
              <Stack spacing={1}>
                <Typography variant="body2">{revocation.text}</Typography>
                <Typography variant="body2">
                  Last revocation attempt:{" "}
                  <time dateTime={lastRevocation.at}>
                    {formatDate(lastRevocation.at)}
                  </time>
                </Typography>
                {removalUrl ? (
                  <Typography variant="body2">
                    <ProviderRemovalLink href={removalUrl} label={label} />
                  </Typography>
                ) : null}
              </Stack>
            </Alert>
          ) : null}
          {connection.connectedBy ? (
            <Typography variant="body2" color="text.secondary">
              Connected by {connection.connectedBy.username ?? "a former user"}
            </Typography>
          ) : null}
          {connection.reconnectBy ? (
            <Typography variant="body2" color="text.secondary">
              Reconnect by {formatDate(connection.reconnectBy)}
            </Typography>
          ) : null}
          {tools}
        </Stack>
      </CardContent>
      {canManage && (canConnect || canReconnect || canDisconnect) ? (
        <CardActions sx={{ justifyContent: "flex-end", px: 2, pb: 2 }}>
          {canDisconnect ? (
            <Button color="error" onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : null}
          {canReconnect ? (
            <Button variant="outlined" onClick={onReconnect}>
              Reconnect
            </Button>
          ) : null}
          {canConnect ? (
            <Button variant="contained" onClick={onConnect}>
              {state === "connecting" ? "Start again" : `Connect ${label}`}
            </Button>
          ) : null}
        </CardActions>
      ) : null}
    </Card>
  );
}
