"use client";

import { TextField } from "@mui/material";

/** Splits the comma-separated project keys field into upper-cased keys. */
export const parseJiraProjectKeys = (raw: string): string[] =>
  raw
    .split(",")
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean);

export const isJiraSiteComplete = (
  baseUrl: string,
  projectKeysRaw: string,
): boolean =>
  baseUrl.trim().length > 0 && parseJiraProjectKeys(projectKeysRaw).length > 0;

/** The Jira site URL and project keys a Jira integration reads from. */
export function JiraSiteFields({
  baseUrl,
  projectKeysRaw,
  onBaseUrlChange,
  onProjectKeysRawChange,
  disabled = false,
}: {
  baseUrl: string;
  projectKeysRaw: string;
  onBaseUrlChange: (value: string) => void;
  onProjectKeysRawChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <TextField
        label="Jira site URL"
        placeholder="https://yourcompany.atlassian.net"
        value={baseUrl}
        onChange={(event) => {
          onBaseUrlChange(event.target.value);
        }}
        disabled={disabled}
        fullWidth
        required
      />
      <TextField
        label="Project keys"
        placeholder="PROJ, BUG, FEAT"
        helperText="Comma-separated list of Jira project keys to sync"
        value={projectKeysRaw}
        onChange={(event) => {
          onProjectKeysRawChange(event.target.value);
        }}
        disabled={disabled}
        fullWidth
        required
      />
    </>
  );
}
