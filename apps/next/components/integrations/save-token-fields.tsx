"use client";

import { useState } from "react";
import {
  Checkbox,
  FormControlLabel,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import {
  ExpiryDateField,
  NameField,
  defaultExpiryDate,
  expiryDateToIso,
  isFutureDate,
} from "@/components/settings/api-key-form-shared";
import { githubTokenExpiryDate } from "@/components/settings/github-token-url";
import {
  ACCOUNT_SETTINGS_HREF,
  CREDENTIAL_PLATFORMS,
  type CredentialPlatform,
} from "./credential-platforms";

/**
 * Whether to save a new token to the user's API keys (on by default), and
 * the name and expiry it's saved under.
 */
export function useSaveTokenOptions(platform: CredentialPlatform) {
  const config = CREDENTIAL_PLATFORMS[platform];
  const [save, setSave] = useState(true);
  const [name, setName] = useState(config.defaultSecretName);
  const [neverExpires, setNeverExpires] = useState(false);
  const [expiryDate, setExpiryDate] = useState(() =>
    platform === "github" ? githubTokenExpiryDate() : defaultExpiryDate(),
  );

  const noExpiry = !config.expiryRequired && neverExpires;
  const expiryIsValid = noExpiry || isFutureDate(expiryDate);
  const isValid = !save || (name.trim().length > 0 && expiryIsValid);

  return {
    platform,
    save,
    setSave,
    name,
    setName,
    neverExpires,
    setNeverExpires,
    expiryDate,
    setExpiryDate,
    expiryIsValid,
    isValid,
    expiresAt: (): string | null =>
      noExpiry ? null : expiryDateToIso(expiryDate),
  };
}

export type SaveTokenOptions = ReturnType<typeof useSaveTokenOptions>;

export function SaveTokenFields({ options }: { options: SaveTokenOptions }) {
  const config = CREDENTIAL_PLATFORMS[options.platform];
  return (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Checkbox
              checked={options.save}
              onChange={(event) => {
                options.setSave(event.target.checked);
              }}
            />
          }
          label="Securely save this token to my API keys"
        />
        <Typography variant="caption" color="text.secondary">
          Scarn encrypts saved tokens and never shows them again. You can
          delete it any time in{" "}
          <Link href={ACCOUNT_SETTINGS_HREF} target="_blank" rel="noopener">
            Account settings
          </Link>
          . If you don&apos;t save it, Scarn uses it only to set up this
          project and keeps nothing. You&apos;ll be asked for a token each time
          you sync or approve a comment.
        </Typography>
      </Stack>
      {options.save ? (
        <Stack spacing={1.5}>
          <NameField
            placeholder={config.defaultSecretName}
            value={options.name}
            onChange={options.setName}
          />
          {config.expiryRequired ? null : (
            <FormControlLabel
              control={
                <Checkbox
                  checked={options.neverExpires}
                  onChange={(event) => {
                    options.setNeverExpires(event.target.checked);
                  }}
                />
              }
              label="No expiry"
            />
          )}
          {!config.expiryRequired && options.neverExpires ? null : (
            <ExpiryDateField
              value={options.expiryDate}
              onChange={options.setExpiryDate}
              isValid={options.expiryIsValid}
              helperText={`Match the expiry date ${config.label} shows for the token.`}
            />
          )}
        </Stack>
      ) : null}
    </Stack>
  );
}
