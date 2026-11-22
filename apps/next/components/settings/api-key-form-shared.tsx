"use client";

import { useState, type ReactNode } from "react";
import {
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type {
  CreateSecretInput,
  SecretContract,
} from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";

export const ATLASSIAN_API_TOKENS_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

export const toDateInputValue = (date: Date): string => {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const defaultExpiryDate = (today: Date = new Date()): string => {
  const next = new Date(today);
  next.setFullYear(next.getFullYear() + 1);
  return toDateInputValue(next);
};

/** Whether a `YYYY-MM-DD` value is a real date after today (local time). */
export const isFutureDate = (
  value: string,
  today: Date = new Date(),
): boolean =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) && value > toDateInputValue(today);

/** End of the chosen day in local time, so a key lasts through its expiry date. */
export const expiryDateToIso = (value: string): string =>
  new Date(`${value}T23:59:59`).toISOString();

export type AddApiKeyFormProps = {
  onCreated: (secret: SecretContract) => void;
  onError: (message: string) => void;
  onSubmitStart: () => void;
};

/**
 * Sends a new API key to `POST /me/secrets`. The caller clears its token field
 * before calling, so the value never outlives the request in form state.
 */
export const useCreateApiKey = ({
  onCreated,
  onError,
  onSubmitStart,
}: AddApiKeyFormProps) => {
  const [isCreating, setIsCreating] = useState(false);

  const create = (body: CreateSecretInput, onSaved: () => void) => {
    onSubmitStart();
    setIsCreating(true);
    void getBrowserScarnApiClient()
      .api.me.secrets.post(body)
      .then(({ data, error }) => {
        if (error) {
          onError(
            parseApiError(error, "Couldn't save that API key. Try again."),
          );
          return;
        }
        onSaved();
        onCreated(data);
      })
      .catch(() => {
        onError("Couldn't save that API key. Try again.");
      })
      .finally(() => {
        setIsCreating(false);
      });
  };

  return { isCreating, create };
};

export function ExpiryDateField({
  value,
  onChange,
  isValid,
  helperText,
}: {
  value: string;
  onChange: (value: string) => void;
  isValid: boolean;
  helperText: string;
}) {
  return (
    <TextField
      label="Expiry date"
      type="date"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      size="small"
      fullWidth
      error={!isValid}
      helperText={isValid ? helperText : "Pick a date in the future."}
      slotProps={{
        inputLabel: { shrink: true },
        htmlInput: { min: toDateInputValue(new Date()) },
      }}
    />
  );
}

export function TokenField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <TextField
      label={label}
      type="password"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      size="small"
      fullWidth
      slotProps={{ htmlInput: { autoComplete: "off" } }}
    />
  );
}

export function NameField({
  placeholder,
  value,
  onChange,
  helperText,
  autoFocus,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  helperText?: string;
  autoFocus?: boolean;
}) {
  return (
    <TextField
      label="Name"
      placeholder={placeholder}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      size="small"
      fullWidth
      autoComplete="off"
      helperText={helperText}
      autoFocus={autoFocus}
    />
  );
}

/** The card + form shell every "Add … key" form shares. */
export function AddApiKeyFormCard({
  title,
  intro,
  canSubmit,
  isSubmitting,
  onSubmit,
  children,
}: {
  title: string;
  intro: ReactNode;
  canSubmit: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <Card sx={{ maxWidth: 480 }}>
      <CardContent sx={{ p: 3 }}>
        <Stack
          spacing={2}
          component="form"
          aria-label={title}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <Typography variant="subtitle1">{title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {intro}
          </Typography>
          {children}
          <Button
            type="submit"
            variant="contained"
            loading={isSubmitting}
            disabled={!canSubmit}
            sx={{ alignSelf: "flex-start" }}
          >
            Save API key
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
