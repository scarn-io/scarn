"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Card,
  CardContent,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import {
  isUsernameSubmittable,
  normalizeUsernameInput,
  usernameHelperText,
  useUsernameAvailability,
} from "@/components/auth/use-username-availability";
import { PageHeader } from "@/components/page-header";
import { ApiKeysPanel } from "./api-keys-panel";

export function AccountSettingsPageClient({
  currentUsername,
}: {
  currentUsername: string;
}) {
  const router = useRouter();
  const [savedUsername, setSavedUsername] = useState<string>(currentUsername);
  const [username, setUsername] = useState<string>(currentUsername);
  const status = useUsernameAvailability(username, { ignore: savedUsername });
  const isUnchanged = normalizeUsernameInput(username) === savedUsername;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = () => {
    const candidate = normalizeUsernameInput(username);
    if (candidate.length === 0 || candidate === savedUsername) {
      return;
    }
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSubmitting(true);
    void getBrowserScarnApiClient()
      .api.username.post({ username: candidate })
      .then(({ data, error }) => {
        if (error) {
          setErrorMessage(
            parseApiError(error, "Couldn't save that username. Try again."),
          );
          setIsSubmitting(false);
          return;
        }
        // `POST /username` always sets a real handle, but the response type is
        // now nullable; fall back to the submitted candidate to stay non-null.
        const savedUsername = data.username ?? candidate;
        setSavedUsername(savedUsername);
        setUsername(savedUsername);
        setSuccessMessage(`Your username is now @${savedUsername}.`);
        setIsSubmitting(false);
        // Refresh server components so the session picks up the new username.
        router.refresh();
      })
      .catch(() => {
        setErrorMessage("Couldn't save that username. Try again.");
        setIsSubmitting(false);
      });
  };

  const helperText = isUnchanged
    ? "This is your current username."
    : usernameHelperText(status);

  const canSubmit =
    !isSubmitting &&
    !isUnchanged &&
    normalizeUsernameInput(username).length > 0 &&
    isUsernameSubmittable(status);

  const endAdornment =
    status === "available" ? (
      <InputAdornment position="end">
        <CheckCircleOutlineIcon color="success" fontSize="small" />
      </InputAdornment>
    ) : status === "taken" || status === "invalid" ? (
      <InputAdornment position="end">
        <ErrorOutlineIcon color="error" fontSize="small" />
      </InputAdornment>
    ) : null;

  return (
    <Stack spacing={4}>
      <PageHeader
        title="Account"
        description="Manage your public handle, API keys, and account settings."
      />
      <Stack spacing={2}>
        <Typography variant="h6">Username</Typography>
        <Typography variant="body2" color="text.secondary">
          Your public handle appears in links to your projects.
        </Typography>
        <Card sx={{ maxWidth: 480 }}>
          <CardContent sx={{ p: 3 }}>
            <Stack
              spacing={3}
              component="form"
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmit();
              }}
            >
              <Alert severity="warning">
                Changing your username will break existing external links to
                your projects. Anyone with an old link will need the updated
                one.
              </Alert>
              {errorMessage ? (
                <Alert severity="error">{errorMessage}</Alert>
              ) : null}
              {successMessage ? (
                <Alert severity="success">{successMessage}</Alert>
              ) : null}
              <TextField
                label="Username"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setSuccessMessage(null);
                }}
                autoComplete="off"
                fullWidth
                size="small"
                error={status === "taken" || status === "invalid"}
                helperText={helperText}
                slotProps={{ input: { endAdornment } }}
              />
              <Button
                type="submit"
                variant="contained"
                loading={isSubmitting}
                disabled={!canSubmit}
                sx={{ alignSelf: "flex-start" }}
              >
                Save username
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Stack>
      <ApiKeysPanel />
    </Stack>
  );
}
