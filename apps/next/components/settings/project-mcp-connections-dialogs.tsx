"use client";

import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
  Stack,
} from "@mui/material";
import type {
  DisconnectManagedConnectionResponse,
  ManagedConnectionContract,
} from "@scarn/api/frontend-contracts";
import { ProjectMcpConnectionUsage } from "./project-mcp-connection-usage";
import {
  revocationMessage,
  sharedAuthorityDisclosure,
} from "./project-mcp-connection-messages";

type DialogStateProps = {
  isSaving: boolean;
  errorMessage: string | null;
  onClose: () => void;
};

/** Where to remove Scarn's access on service `label`'s side. */
export function ProviderRemovalLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <>
      To make sure Scarn no longer has access, remove it in{" "}
      <Link href={href} target="_blank" rel="noreferrer">
        {label}&apos;s connections settings
      </Link>
      .
    </>
  );
}

/**
 * Connect or reconnect connection `label`: the shared-authority disclosure
 * comes before the person leaves for the service (decision 4). Continuing
 * starts the attempt and leaves the page, so the button stays busy until the
 * browser navigates.
 */
export function StartConnectionDialog({
  label,
  kind,
  isSaving,
  errorMessage,
  onClose,
  onConfirm,
}: DialogStateProps & {
  label: string;
  kind: "connect" | "reconnect";
  onConfirm: () => void;
}) {
  const title = kind === "connect" ? `Connect ${label}` : `Reconnect ${label}`;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
          <Alert severity="warning">{sharedAuthorityDisclosure(label)}</Alert>
          <DialogContentText>
            You&apos;ll go to {label} to choose the account and what to share.
            When you come back, you&apos;ll see which account and permissions{" "}
            {label} granted and can confirm or cancel.
          </DialogContentText>
          {kind === "reconnect" ? (
            <DialogContentText>
              The current connection keeps working until you confirm the new
              one.
            </DialogContentText>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button variant="contained" loading={isSaving} onClick={onConfirm}>
          Continue to {label}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DisconnectOutcome({
  label,
  result,
}: {
  label: string;
  result: DisconnectManagedConnectionResponse;
}) {
  const outcome = result.revocation
    ? revocationMessage(result.revocation, label)
    : null;
  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <Alert severity="success">
        Disconnected. Steps in this project can no longer act in {label} through
        this connection.
      </Alert>
      {outcome ? (
        <Alert severity={outcome.severity}>{outcome.text}</Alert>
      ) : (
        <DialogContentText>
          Nothing had been connected yet, so there was nothing to revoke at{" "}
          {label}.
        </DialogContentText>
      )}
      {result.providerRemovalUrl ? (
        <DialogContentText>
          <ProviderRemovalLink href={result.providerRemovalUrl} label={label} />
        </DialogContentText>
      ) : null}
    </Stack>
  );
}

/**
 * Disconnect `connection` asks first, then stays open to report what the
 * service said about the revocation request and, when its preset names one,
 * where to remove the connection on the service's side (decision 6). It
 * never claims the tokens are gone at the service.
 */
export function DisconnectConnectionDialog({
  projectId,
  connection,
  result,
  isSaving,
  errorMessage,
  onClose,
  onConfirm,
}: DialogStateProps & {
  projectId: string;
  connection: ManagedConnectionContract;
  result: DisconnectManagedConnectionResponse | null;
  onConfirm: () => void;
}) {
  const { label } = connection;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {result ? `${label} disconnected` : `Disconnect ${label}?`}
      </DialogTitle>
      <DialogContent>
        {result ? (
          <DisconnectOutcome label={label} result={result} />
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            {errorMessage ? (
              <Alert severity="error">{errorMessage}</Alert>
            ) : null}
            <DialogContentText>
              Scarn deletes this connection&apos;s credentials right away and
              asks {label} once to revoke its access. Steps that use this
              connection stop working until someone connects again.
            </DialogContentText>
            <ProjectMcpConnectionUsage
              key={`${connection.id}:${String(connection.version)}`}
              projectId={projectId}
              connectionId={connection.id}
            />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {result ? (
          <Button variant="contained" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              variant="contained"
              color="error"
              loading={isSaving}
              onClick={onConfirm}
            >
              Disconnect
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
