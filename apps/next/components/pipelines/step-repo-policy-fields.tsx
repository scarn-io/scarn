"use client";

import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
} from "@mui/material";
import type { StepRepoSettings } from "./step-definition-dialog-helpers";

export function StepRepoPolicyFields({
  settings,
  onChange,
}: {
  settings: StepRepoSettings;
  onChange: (settings: StepRepoSettings) => void;
}) {
  const set = (patch: Partial<StepRepoSettings>) => {
    onChange({ ...settings, ...patch });
  };
  return (
    <>
      <FormControl fullWidth>
        <InputLabel>Repository access</InputLabel>
        <Select
          label="Repository access"
          value={settings.mode}
          onChange={(event) => {
            set({ mode: event.target.value });
          }}
        >
          <MenuItem value="readOnly">Read only</MenuItem>
          <MenuItem value="readWrite">Read / write</MenuItem>
        </Select>
      </FormControl>
      <FormControl fullWidth>
        <InputLabel>Git credentials</InputLabel>
        <Select
          label="Git credentials"
          value={settings.gitCredentials}
          onChange={(event) => {
            set({ gitCredentials: event.target.value });
          }}
        >
          <MenuItem value="auto">Automatic</MenuItem>
          <MenuItem value="none">None</MenuItem>
        </Select>
      </FormControl>
      <TextField
        label="Base branch"
        value={settings.baseBranch}
        onChange={(event) => {
          set({ baseBranch: event.target.value });
        }}
        placeholder="Previous step's branch, else project or remote default"
        helperText="A branch name; may use {{input.…}}, {{env.NAME}} and {{workItem.platformKey}}. When set, it beats the previous step's branch."
        fullWidth
      />
      {settings.mode === "readWrite" ? (
        <FormControl fullWidth>
          <InputLabel>Work branch</InputLabel>
          <Select
            label="Work branch"
            value={settings.workBranch}
            onChange={(event) => {
              set({ workBranch: event.target.value });
            }}
          >
            <MenuItem value="create">Create a new branch</MenuItem>
            <MenuItem value="base">
              Commit onto the branch it started from
            </MenuItem>
          </Select>
        </FormControl>
      ) : null}
    </>
  );
}
