"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  CircularProgress,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from "@mui/material";
import type { SecretContract } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import type { SavedCredentialKind } from "./credential-platforms";

/** The radio value for "type a new / pasted credential" rather than a saved one. */
export const NEW_CREDENTIAL_OPTION = "new";

export type SavedCredentialsState =
  | { status: "loading" }
  | { status: "loaded"; keys: SecretContract[] }
  | { status: "failed" };

/**
 * The key most recently used, falling back to the first key that hasn't
 * expired. Returns the new-credential option when every saved key is expired.
 */
export function defaultSavedCredentialOption(keys: SecretContract[]): string {
  const usable = keys.filter((key) => key.status !== "expired");
  if (usable.length === 0) return NEW_CREDENTIAL_OPTION;
  const used = usable
    .filter((key) => key.lastUsedAt !== null)
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  return (used[0] ?? usable[0])?.id ?? NEW_CREDENTIAL_OPTION;
}

/**
 * Loads the caller's saved keys of one kind (`GET /me/secrets?kind=`) while
 * `active` is true, and tracks which one is selected.
 */
export function useSavedCredentials(
  kind: SavedCredentialKind,
  active: boolean,
) {
  const [state, setState] = useState<SavedCredentialsState>({
    status: "loading",
  });
  const [selected, setSelected] = useState<string>(NEW_CREDENTIAL_OPTION);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState({ status: "loading" });
    const fail = () => {
      if (cancelled) return;
      setState({ status: "failed" });
      setSelected(NEW_CREDENTIAL_OPTION);
    };
    void getBrowserScarnApiClient()
      .api.me.secrets.get({ query: { kind } })
      .then(({ data, error }) => {
        if (error) {
          fail();
          return;
        }
        if (cancelled) return;
        const keys = data.filter((key) => key.kind === kind);
        setState({ status: "loaded", keys });
        setSelected(defaultSavedCredentialOption(keys));
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [kind, active]);

  const keys = state.status === "loaded" ? state.keys : [];
  const selectedKey = keys.find(
    (key) => key.id === selected && key.status !== "expired",
  );
  const addKey = (key: SecretContract) => {
    if (key.kind !== kind) return;
    setState((current) => ({
      status: "loaded",
      keys: [...(current.status === "loaded" ? current.keys : []), key],
    }));
    setSelected(key.id);
  };
  return {
    state,
    keys,
    selected,
    setSelected,
    selectedKey,
    addKey,
    isNew: selected === NEW_CREDENTIAL_OPTION,
  };
}

const keyCaption = (key: SecretContract): string => {
  const account =
    key.kind === "github_token" ? key.metadata.login : key.metadata.email;
  return account ? `${account} · ••••${key.lastFour}` : `••••${key.lastFour}`;
};

/**
 * The loading/failed notices and the radio list of saved keys, plus a final
 * option for a new credential. Expired keys are listed but can't be picked.
 */
export function SavedCredentialList({
  state,
  selected,
  onSelect,
  label,
  newOptionLabel,
  failedMessage = "Couldn't load your saved API keys. You can paste a key instead.",
}: {
  state: SavedCredentialsState;
  selected: string;
  onSelect: (value: string) => void;
  label: string;
  newOptionLabel: string;
  failedMessage?: string;
}) {
  if (state.status === "loading") {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          Loading your saved API keys…
        </Typography>
      </Stack>
    );
  }
  if (state.status === "failed") {
    return <Alert severity="warning">{failedMessage}</Alert>;
  }
  if (state.keys.length === 0) return null;

  return (
    <RadioGroup
      aria-label={label}
      value={selected}
      onChange={(event) => {
        onSelect(event.target.value);
      }}
    >
      {state.keys.map((key) => {
        const expired = key.status === "expired";
        return (
          <FormControlLabel
            key={key.id}
            value={key.id}
            disabled={expired}
            control={<Radio size="small" />}
            label={
              <Stack>
                <Typography variant="body2">{key.name}</Typography>
                <Typography
                  variant="caption"
                  color={expired ? "error" : "text.secondary"}
                >
                  {expired
                    ? "Expired — replace it in Account settings"
                    : keyCaption(key)}
                </Typography>
              </Stack>
            }
          />
        );
      })}
      <FormControlLabel
        value={NEW_CREDENTIAL_OPTION}
        control={<Radio size="small" />}
        label={<Typography variant="body2">{newOptionLabel}</Typography>}
      />
    </RadioGroup>
  );
}
