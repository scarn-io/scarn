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
} from "./use-username-availability";

export function ChooseUsernameCard({
  callbackUrl,
  initialUsername = "",
}: {
  callbackUrl: string;
  initialUsername?: string;
}) {
  const router = useRouter();
  const [username, setUsername] = useState<string>(initialUsername);
  const status = useUsernameAvailability(username);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = () => {
    const candidate = normalizeUsernameInput(username);
    if (candidate.length === 0) {
      setErrorMessage("Enter a username to continue.");
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);
    void getBrowserScarnApiClient()
      .api.username.post({ username: candidate })
      .then(({ error }) => {
        if (error) {
          setErrorMessage(
            parseApiError(error, "Couldn't save that username. Try again."),
          );
          setIsSubmitting(false);
          return;
        }
        // Full reload so server components re-read the session with the new
        // username + chosen flag, clearing the onboarding redirect. Send them
        // back to whatever page they were originally trying to reach.
        router.refresh();
        window.location.href = callbackUrl;
      })
      .catch(() => {
        setErrorMessage("Couldn't save that username. Try again.");
        setIsSubmitting(false);
      });
  };

  const helperText = usernameHelperText(status);

  const canSubmit =
    !isSubmitting &&
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
    <Stack spacing={3} alignItems="center" sx={{ width: "100%", maxWidth: 360 }}>
      <Stack spacing={1.5} alignItems="center">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, no next/image optimization needed */}
        <img
          src="/brand-icon.svg"
          alt=""
          width={40}
          height={40}
          style={{
            display: "block",
            borderRadius: "18%",
            boxShadow:
              "0 6px 20px -4px color-mix(in srgb, var(--color-accent) 40%, transparent)",
          }}
        />
        <Typography variant="h2" component="h1" sx={{ fontSize: "1.25rem" }}>
          Choose your username
        </Typography>
      </Stack>
      <Card sx={{ width: "100%" }}>
        <CardContent sx={{ p: 3 }}>
          <Stack
            spacing={3}
            component="form"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Choose a public handle for your account. You can change it later in
              settings.
            </Typography>
            {errorMessage ? (
              <Alert severity="error">{errorMessage}</Alert>
            ) : null}
            <TextField
              label="Username"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              autoComplete="off"
              autoFocus
              fullWidth
              size="small"
              error={status === "taken" || status === "invalid"}
              helperText={helperText}
              slotProps={{ input: { endAdornment } }}
            />
            <Button
              type="submit"
              size="large"
              variant="contained"
              loading={isSubmitting}
              disabled={!canSubmit}
            >
              Continue
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
