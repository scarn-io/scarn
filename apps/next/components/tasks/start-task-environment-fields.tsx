"use client";

/**
 * The start dialog's Environment select: the step's or repo's default first,
 * then the project's named environments. An inline step environment can't be
 * replaced, so the select is disabled with a note.
 */
import { MenuItem, TextField } from "@mui/material";
import type { ProjectEnvironment } from "./use-project-environments";

const DEFAULT_VALUE = "";

export function StartTaskEnvironmentField({
  defaultLabel,
  environments,
  value,
  locked,
  error,
  onChange,
}: {
  defaultLabel: string;
  environments: readonly ProjectEnvironment[];
  value: string;
  locked: boolean;
  error: string | undefined;
  onChange: (name: string) => void;
}) {
  const helperText =
    error ??
    (locked
      ? "This step defines its own environment, so it can't be replaced."
      : "Runs this Task in a named environment instead.");
  return (
    <TextField
      select
      label="Environment"
      value={locked ? DEFAULT_VALUE : value}
      disabled={locked}
      error={error !== undefined}
      helperText={helperText}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      slotProps={{
        select: { displayEmpty: true },
        inputLabel: { shrink: true },
      }}
    >
      <MenuItem value={DEFAULT_VALUE}>{defaultLabel}</MenuItem>
      {environments.map((environment) => (
        <MenuItem key={environment.name} value={environment.name}>
          {environment.name}
        </MenuItem>
      ))}
    </TextField>
  );
}
