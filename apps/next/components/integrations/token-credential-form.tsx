"use client";

import { useState, type ReactNode } from "react";
import { Alert, Button, Stack } from "@mui/material";
import type {
  IntegrationCredentialChoice,
  SecretContract,
} from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import {
  CREDENTIAL_PLATFORMS,
  isPastedCredentialComplete,
  pastedCredential,
  saveSecretBody,
  type CredentialPlatform,
  type PastedCredentialInput,
} from "./credential-platforms";
import {
  PastedCredentialFields,
  usePastedCredential,
} from "./pasted-credential-fields";
import {
  SavedCredentialList,
  useSavedCredentials,
} from "./saved-credential-list";
import { SaveTokenFields, useSaveTokenOptions } from "./save-token-fields";

export type CredentialCheckResult =
  | {
      ok: true;
      account: string;
      repo: { id: number; fullName: string } | null;
    }
  | CredentialCheckFailure;

/** A failed check; `code` is the server's error code when it sent one. */
export type CredentialCheckFailure = {
  ok: false;
  message: string;
  code?: string | undefined;
};

/** How the checked credential reaches the server, for the summary line. */
export type CredentialConnection =
  { method: "saved"; name: string } | { method: "unsaved" };

export type VerifiedCredential = {
  credential: IntegrationCredentialChoice;
  connection: CredentialConnection;
  account: string;
  repo: { id: number; fullName: string } | null;
};

/**
 * Picks a saved token or takes a new one, checks it with `check`, and (when
 * the save box is ticked) saves a new token to the user's API keys before
 * handing back `{ secretId }`. An unsaved token is handed back as typed and
 * lives only in the caller's memory. The token field is cleared as soon as
 * the token is sent.
 */
export function TokenCredentialForm({
  platform,
  check,
  onVerified,
  ready = true,
  help,
  submitLabel = "Check and continue",
  renderError,
}: {
  platform: CredentialPlatform;
  check: (
    credential: IntegrationCredentialChoice,
  ) => Promise<CredentialCheckResult>;
  onVerified: (verified: VerifiedCredential) => void;
  /** False while fields the caller owns (e.g. the Jira site) are incomplete. */
  ready?: boolean;
  help?: ReactNode;
  submitLabel?: string;
  /** Replaces the default error alert, e.g. to offer a next step for a code. */
  renderError?: (failure: CredentialCheckFailure) => ReactNode;
}) {
  const config = CREDENTIAL_PLATFORMS[platform];
  const saved = useSavedCredentials(config.secretKind, true);
  const pasted = usePastedCredential(true);
  const saveOptions = useSaveTokenOptions(platform);
  const [error, setError] = useState<CredentialCheckFailure | null>(null);
  const fail = (message: string, code?: string) => {
    setError({ ok: false, message, code });
  };
  const [isChecking, setIsChecking] = useState(false);

  const isNew = saved.isNew;
  const canSubmit =
    ready &&
    !isChecking &&
    saved.state.status !== "loading" &&
    (isNew
      ? isPastedCredentialComplete(platform, pasted.value) &&
        saveOptions.isValid
      : saved.selectedKey !== undefined);

  const saveNewToken = async (
    input: PastedCredentialInput,
    account: string,
  ): Promise<{ secretId: SecretContract["id"] } | { message: string }> => {
    const { data, error: saveError } =
      await getBrowserScarnApiClient().api.me.secrets.post(
        saveSecretBody(platform, input, {
          name: saveOptions.name,
          expiresAt: saveOptions.expiresAt(),
          account: platform === "github" ? account : null,
        }),
      );
    if (saveError) {
      return {
        message: parseApiError(
          saveError,
          "Couldn't save that token. Try again.",
        ),
      };
    }
    return { secretId: data.id };
  };

  const verify = async () => {
    if (!isNew) {
      const key = saved.selectedKey;
      if (!key) return;
      const result = await check({ secretId: key.id });
      if (!result.ok) {
        setError(result);
        return;
      }
      onVerified({
        credential: { secretId: key.id },
        connection: { method: "saved", name: key.name },
        account: result.account,
        repo: result.repo,
      });
      return;
    }

    const input = { ...pasted.value };
    const credential = pastedCredential(platform, input);
    pasted.clearToken();
    const result = await check(credential);
    if (!result.ok) {
      setError(result);
      return;
    }
    if (!saveOptions.save) {
      onVerified({
        credential,
        connection: { method: "unsaved" },
        account: result.account,
        repo: result.repo,
      });
      return;
    }
    const savedSecret = await saveNewToken(input, result.account);
    if ("message" in savedSecret) {
      fail(savedSecret.message);
      return;
    }
    onVerified({
      credential: { secretId: savedSecret.secretId },
      connection: { method: "saved", name: saveOptions.name.trim() },
      account: result.account,
      repo: result.repo,
    });
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    setIsChecking(true);
    void verify()
      .catch(() => {
        fail("Couldn't check that token. Try again.");
      })
      .finally(() => {
        setIsChecking(false);
      });
  };

  return (
    <Stack
      spacing={2}
      component="form"
      aria-label={`Connect ${config.label}`}
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      {help}
      <SavedCredentialList
        state={saved.state}
        selected={saved.selected}
        onSelect={saved.setSelected}
        label={`Saved ${config.label} tokens`}
        newOptionLabel="Use a new token"
      />
      {saved.state.status !== "loading" && isNew ? (
        <>
          <PastedCredentialFields
            platform={platform}
            value={pasted.value}
            onEmailChange={pasted.setEmail}
            onTokenChange={pasted.setToken}
          />
          <SaveTokenFields options={saveOptions} />
        </>
      ) : null}
      {error
        ? (renderError?.(error) ?? (
            <Alert severity="error">{error.message}</Alert>
          ))
        : null}
      <Button
        type="submit"
        variant="contained"
        loading={isChecking}
        disabled={!canSubmit}
        sx={{ alignSelf: "flex-start" }}
      >
        {submitLabel}
      </Button>
    </Stack>
  );
}
