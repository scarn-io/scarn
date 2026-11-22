"use client";

import { useState } from "react";
import { Button, Stack, TextField, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { ExistingProjectWarning } from "./existing-project-warning";
import type { RepoCheck } from "./repo-host";

/** Step 2: the project's name (defaulting from the repo) and description. */
export function ProjectDetailsStep({
  gitUrl,
  check,
  initialName,
  initialDescription,
  onBack,
  onContinue,
}: {
  gitUrl: string;
  check: RepoCheck;
  initialName: string | null;
  initialDescription: string | null;
  onBack: () => void;
  onContinue: (details: { name: string; description: string }) => void;
}) {
  const [name, setName] = useState(initialName ?? check.defaultName);
  const [description, setDescription] = useState(initialDescription ?? "");

  return (
    <Stack
      spacing={2.5}
      component="form"
      aria-label="Details"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onContinue({ name: name.trim(), description: description.trim() });
      }}
      sx={{ py: 1 }}
    >
      <Stack spacing={0.5}>
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ letterSpacing: "0.06em" }}
        >
          Repository
        </Typography>
        <Typography
          sx={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.875rem",
            overflowWrap: "anywhere",
          }}
        >
          {gitUrl}
        </Typography>
      </Stack>
      <ExistingProjectWarning check={check} />
      <TextField
        label="Project name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        required
        fullWidth
        autoFocus
      />
      <TextField
        label="Description"
        value={description}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
        multiline
        minRows={2}
        fullWidth
      />
      <Stack direction="row" spacing={1.5}>
        <Button
          variant="text"
          color="inherit"
          startIcon={<ArrowBackIcon />}
          onClick={onBack}
        >
          Back
        </Button>
        <Button type="submit" variant="contained" disabled={!name.trim()}>
          Continue
        </Button>
      </Stack>
    </Stack>
  );
}
