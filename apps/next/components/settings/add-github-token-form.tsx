"use client";

import { useState } from "react";
import { Checkbox, FormControlLabel, Link } from "@mui/material";
import {
  AddApiKeyFormCard,
  ExpiryDateField,
  NameField,
  TokenField,
  expiryDateToIso,
  isFutureDate,
  useCreateApiKey,
  type AddApiKeyFormProps,
} from "./api-key-form-shared";
import { githubTokenExpiryDate, githubTokenUrl } from "./github-token-url";

/**
 * "Add GitHub token" form for a fine-grained or classic personal access
 * token. Classic tokens can be set to never expire, so the expiry is
 * optional. The token is cleared from state as soon as the request is sent.
 */
export function AddGitHubTokenForm(props: AddApiKeyFormProps) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [neverExpires, setNeverExpires] = useState(false);
  const [expiryDate, setExpiryDate] = useState(() => githubTokenExpiryDate());
  const { isCreating, create } = useCreateApiKey(props);

  const expiryIsValid = neverExpires || isFutureDate(expiryDate);
  const canCreate =
    !isCreating &&
    name.trim().length > 0 &&
    token.trim().length > 0 &&
    expiryIsValid;

  const handleCreate = () => {
    if (!canCreate) return;
    const body = {
      kind: "github_token" as const,
      name: name.trim(),
      value: token.trim(),
      expiresAt: neverExpires ? null : expiryDateToIso(expiryDate),
    };
    setToken("");
    create(body, () => {
      setName("");
      setNeverExpires(false);
      setExpiryDate(githubTokenExpiryDate());
    });
  };

  return (
    <AddApiKeyFormCard
      title="Add GitHub token"
      intro={
        <>
          <Link
            href={githubTokenUrl()}
            target="_blank"
            rel="noopener noreferrer"
          >
            Create a GitHub token
          </Link>{" "}
          with Scarn&apos;s permissions already filled in. Pick the resource
          owner and the repositories it should reach, then generate it.
        </>
      }
      canSubmit={canCreate}
      isSubmitting={isCreating}
      onSubmit={handleCreate}
    >
      <NameField placeholder="Personal GitHub" value={name} onChange={setName} />
      <TokenField label="GitHub token" value={token} onChange={setToken} />
      <FormControlLabel
        control={
          <Checkbox
            checked={neverExpires}
            onChange={(event) => {
              setNeverExpires(event.target.checked);
            }}
          />
        }
        label="This token never expires"
      />
      {neverExpires ? null : (
        <ExpiryDateField
          value={expiryDate}
          onChange={setExpiryDate}
          isValid={expiryIsValid}
          helperText="Match the expiry date GitHub shows for the token."
        />
      )}
    </AddApiKeyFormCard>
  );
}
