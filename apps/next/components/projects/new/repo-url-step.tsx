"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { ExistingProjectWarning } from "./existing-project-warning";
import { hostChipLabel, type RepoCheck } from "./repo-host";

/**
 * Step 1: the repository URL. A chip names the host as the user types.
 * Continue checks the repo (`POST /projects/repo-check`); if one of the
 * user's projects already uses it, a warning links there and Continue still
 * goes ahead on the second press.
 */
export function RepoUrlStep({
  initialGitUrl,
  onContinue,
}: {
  initialGitUrl: string;
  onContinue: (gitUrl: string, check: RepoCheck) => void;
}) {
  const [gitUrl, setGitUrl] = useState(initialGitUrl);
  const [check, setCheck] = useState<{
    gitUrl: string;
    result: RepoCheck;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const trimmed = gitUrl.trim();
  const chip = hostChipLabel(gitUrl);
  const confirmedDuplicate =
    check !== null && check.gitUrl === trimmed && check.result.alreadyExists;

  const handleContinue = () => {
    if (!trimmed || isChecking) return;
    if (confirmedDuplicate) {
      onContinue(trimmed, check.result);
      return;
    }
    setError(null);
    setIsChecking(true);
    void getBrowserScarnApiClient()
      .api.projects["repo-check"].post({ gitUrl: trimmed })
      .then(({ data, error: checkError }) => {
        if (checkError) {
          setError(
            parseApiError(checkError, "Couldn't check that repository URL."),
          );
          return;
        }
        setCheck({ gitUrl: trimmed, result: data });
        if (!data.alreadyExists) onContinue(trimmed, data);
      })
      .catch(() => {
        setError("Couldn't check that repository URL. Try again.");
      })
      .finally(() => {
        setIsChecking(false);
      });
  };

  return (
    <Stack
      spacing={2.5}
      component="form"
      aria-label="Repository"
      onSubmit={(event) => {
        event.preventDefault();
        handleContinue();
      }}
      sx={{ py: 1 }}
    >
      <Typography variant="body2" color="text.secondary">
        Paste the URL of the git repository you want an agent to work in.
      </Typography>
      <TextField
        label="Repository URL"
        placeholder="https://github.com/acme/api"
        value={gitUrl}
        onChange={(event) => {
          setGitUrl(event.target.value);
        }}
        required
        fullWidth
        autoFocus
        sx={{
          "& .MuiInputBase-input": { fontFamily: "var(--font-mono)" },
        }}
      />
      {chip ? (
        <Chip
          size="small"
          variant="outlined"
          label={chip}
          sx={{ alignSelf: "flex-start" }}
        />
      ) : null}
      {check && check.gitUrl === trimmed ? (
        <ExistingProjectWarning check={check.result} />
      ) : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Button
        type="submit"
        variant="contained"
        loading={isChecking}
        disabled={!trimmed}
        sx={{ alignSelf: "flex-start" }}
      >
        {confirmedDuplicate ? "Continue anyway" : "Continue"}
      </Button>
    </Stack>
  );
}
