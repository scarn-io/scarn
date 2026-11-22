"use client";

import { useEffect, useState } from "react";
import { Stack, TextField } from "@mui/material";
import { authClient } from "@/app/_lib/auth-client";
import {
  CREDENTIAL_PLATFORMS,
  type CredentialPlatform,
  type PastedCredentialInput,
} from "./credential-platforms";

/**
 * The pasted email (seeded from the session until edited) and token for a
 * platform. Both reset whenever `active` turns on. Callers clear the token
 * once it's been sent.
 */
export function usePastedCredential(active: boolean) {
  const { data: session } = authClient.useSession();
  const sessionEmail = session?.user.email ?? "";
  const [email, setEmail] = useState("");
  const [emailEdited, setEmailEdited] = useState(false);
  const [token, setToken] = useState("");

  useEffect(() => {
    if (!active) return;
    setToken("");
    setEmailEdited(false);
  }, [active]);

  useEffect(() => {
    if (active && !emailEdited) setEmail(sessionEmail);
  }, [active, emailEdited, sessionEmail]);

  return {
    value: { email, token } satisfies PastedCredentialInput,
    setEmail: (next: string) => {
      setEmail(next);
      setEmailEdited(true);
    },
    setToken,
    clearToken: () => {
      setToken("");
    },
  };
}

export function PastedCredentialFields({
  platform,
  value,
  onEmailChange,
  onTokenChange,
  onSubmit,
  autoFocus = false,
}: {
  platform: CredentialPlatform;
  value: PastedCredentialInput;
  onEmailChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
}) {
  const config = CREDENTIAL_PLATFORMS[platform];
  return (
    <Stack spacing={1.5}>
      {config.needsEmail ? (
        <TextField
          label="Atlassian email"
          type="email"
          value={value.email}
          onChange={(event) => {
            onEmailChange(event.target.value);
          }}
          size="small"
          fullWidth
        />
      ) : null}
      <TextField
        label={config.tokenLabel}
        type="password"
        value={value.token}
        onChange={(event) => {
          onTokenChange(event.target.value);
        }}
        size="small"
        fullWidth
        autoFocus={autoFocus}
        slotProps={{ htmlInput: { autoComplete: "off" } }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </Stack>
  );
}
