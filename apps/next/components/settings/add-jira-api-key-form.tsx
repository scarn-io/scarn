"use client";

import { useState } from "react";
import { Link, TextField } from "@mui/material";
import {
  ATLASSIAN_API_TOKENS_URL,
  AddApiKeyFormCard,
  ExpiryDateField,
  NameField,
  TokenField,
  defaultExpiryDate,
  expiryDateToIso,
  isFutureDate,
  useCreateApiKey,
  type AddApiKeyFormProps,
} from "./api-key-form-shared";

/**
 * "Add Jira API key" form. The token is cleared from state as soon as the
 * request is sent, whether or not the save succeeds.
 */
export function AddJiraApiKeyForm(props: AddApiKeyFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [expiryDate, setExpiryDate] = useState(() => defaultExpiryDate());
  const { isCreating, create } = useCreateApiKey(props);

  const expiryIsValid = isFutureDate(expiryDate);
  const canCreate =
    !isCreating &&
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    apiToken.trim().length > 0 &&
    expiryIsValid;

  const handleCreate = () => {
    if (!canCreate) return;
    const body = {
      kind: "jira_api_key" as const,
      name: name.trim(),
      email: email.trim(),
      value: apiToken.trim(),
      expiresAt: expiryDateToIso(expiryDate),
    };
    setApiToken("");
    create(body, () => {
      setName("");
      setEmail("");
      setExpiryDate(defaultExpiryDate());
    });
  };

  return (
    <AddApiKeyFormCard
      title="Add Jira API key"
      intro={
        <>
          Create a token on your{" "}
          <Link
            href={ATLASSIAN_API_TOKENS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Atlassian API tokens page
          </Link>
          . Set the expiry date below to match the date Atlassian shows for the
          token.
        </>
      }
      canSubmit={canCreate}
      isSubmitting={isCreating}
      onSubmit={handleCreate}
    >
      <NameField placeholder="Work Jira" value={name} onChange={setName} />
      <TextField
        label="Atlassian email"
        type="email"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
        size="small"
        fullWidth
      />
      <TokenField label="API token" value={apiToken} onChange={setApiToken} />
      <ExpiryDateField
        value={expiryDate}
        onChange={setExpiryDate}
        isValid={expiryIsValid}
        helperText="Match the expiry date shown on the Atlassian API tokens page."
      />
    </AddApiKeyFormCard>
  );
}
