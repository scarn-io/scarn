"use client";

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import type { IntegrationCredentialChoice } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import {
  ACCOUNT_SETTINGS_HREF,
  CREDENTIAL_PLATFORMS,
  isPastedCredentialComplete,
  pastedCredential,
  type CredentialPlatform,
} from "./credential-platforms";
import {
  PastedCredentialFields,
  usePastedCredential,
} from "./pasted-credential-fields";
import {
  SavedCredentialList,
  useSavedCredentials,
} from "./saved-credential-list";

type IntegrationCredentialDialogProps = {
  platform: CredentialPlatform;
  open: boolean;
  onClose: () => void;
  onConfirm: (choice: IntegrationCredentialChoice) => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
};

/**
 * Asks for the credential an action on a `user_credential` integration needs:
 * one of the caller's saved keys for the platform, or a pasted one. Hands the
 * choice to `onConfirm`; a pasted token is cleared from state as soon as it's
 * handed over.
 */
export function IntegrationCredentialDialog({
  platform,
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Sync",
}: IntegrationCredentialDialogProps) {
  const config = CREDENTIAL_PLATFORMS[platform];
  const saved = useSavedCredentials(config.secretKind, open);
  const pasted = usePastedCredential(open);

  const hasSavedKeys = saved.keys.length > 0;
  const isPasting = saved.isNew;
  const canConfirm =
    saved.state.status !== "loading" &&
    (isPasting
      ? isPastedCredentialComplete(platform, pasted.value)
      : saved.selectedKey !== undefined);

  const handleClose = () => {
    pasted.clearToken();
    onClose();
  };

  const handleConfirm = () => {
    if (!canConfirm) return;
    let choice: IntegrationCredentialChoice;
    if (isPasting) {
      choice = pastedCredential(platform, pasted.value);
    } else if (saved.selectedKey) {
      choice = { secretId: saved.selectedKey.id };
    } else {
      return;
    }
    pasted.clearToken();
    onConfirm(choice);
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title ?? `Choose a ${config.label} API key`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {description ? (
            <Typography variant="body2" color="text.secondary">
              {description}
            </Typography>
          ) : null}
          <SavedCredentialList
            state={saved.state}
            selected={saved.selected}
            onSelect={saved.setSelected}
            label={`${config.label} API key`}
            newOptionLabel="Paste a key instead"
          />
          {saved.state.status !== "loading" && isPasting ? (
            <Stack spacing={1}>
              <PastedCredentialFields
                platform={platform}
                value={pasted.value}
                onEmailChange={pasted.setEmail}
                onTokenChange={pasted.setToken}
                onSubmit={handleConfirm}
                autoFocus={!hasSavedKeys}
              />
              <Typography variant="caption" color="text.secondary">
                A pasted key is used only for this request and is never stored.
                {hasSavedKeys ? null : (
                  <>
                    {" "}
                    <Link
                      href={ACCOUNT_SETTINGS_HREF}
                      target="_blank"
                      rel="noopener"
                    >
                      Save a key for next time
                    </Link>
                  </>
                )}
              </Typography>
            </Stack>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleConfirm}
          disabled={!canConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
