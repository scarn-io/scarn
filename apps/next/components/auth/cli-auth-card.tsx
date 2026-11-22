"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { authClient } from "@/app/_lib/auth-client";

const formatUserCode = (value: string) =>
  value
    .trim()
    .replace(/[^A-Za-z0-9]/gu, "")
    .toUpperCase();

const getErrorMessage = (error: string | null) => {
  switch (error) {
    case "invalid_request":
      return "That CLI sign-in code is invalid or has expired.";
    case "expired_token":
      return "That CLI sign-in request expired. Start the login command again.";
    case "device_code_already_processed":
      return "That CLI sign-in request was already used.";
    case "access_denied":
      return "That CLI sign-in request was denied.";
    default:
      return "CLI sign-in could not be completed.";
  }
};

export const CLI_AUTH_APPROVED_MESSAGE =
  "Approved — return to your terminal; it will continue automatically.";

export const CLI_AUTH_DENIED_MESSAGE =
  "Denied — the CLI won't be signed in. You can close this tab.";

type Decision = "approve" | "deny";

type Outcome = { kind: "approved" } | { kind: "denied" } | null;

export function CliAuthCard({
  initialUserCode,
}: {
  initialUserCode: string | null;
}) {
  const [userCode, setUserCode] = useState(initialUserCode ?? "");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [pendingDecision, setPendingDecision] = useState<Decision | null>(null);
  const [isPending, startTransition] = useTransition();

  const isDecided = outcome !== null;
  const isBusy = isPending || isDecided;

  const decide = (decision: Decision) => {
    const formattedUserCode = formatUserCode(userCode);
    setUserCode(formattedUserCode);
    setErrorMessage(null);

    if (formattedUserCode.length === 0) {
      setErrorMessage("Enter the code shown in your terminal.");
      return;
    }

    setPendingDecision(decision);
    startTransition(async () => {
      const verifyResult = await authClient.device({
        query: { user_code: formattedUserCode },
      });

      if (verifyResult.error) {
        const message = getErrorMessage(verifyResult.error.error);
        startTransition(() => {
          setErrorMessage(message);
        });
        return;
      }

      const result =
        decision === "approve"
          ? await authClient.device.approve({ userCode: formattedUserCode })
          : await authClient.device.deny({ userCode: formattedUserCode });

      startTransition(() => {
        if (result.error) {
          setErrorMessage(getErrorMessage(result.error.error));
          return;
        }
        setOutcome({ kind: decision === "approve" ? "approved" : "denied" });
      });
    });
  };

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
          Approve Scarn CLI access
        </Typography>
      </Stack>
      <Card sx={{ width: "100%" }}>
        <CardContent sx={{ p: 3 }}>
          <Stack
            spacing={3}
            component="form"
            onSubmit={(event) => {
              event.preventDefault();
              decide("approve");
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Confirm the one-time code shown in your terminal.
            </Typography>
            {errorMessage ? (
              <Alert severity="error">{errorMessage}</Alert>
            ) : null}
            {outcome?.kind === "approved" ? (
              <Alert severity="success">{CLI_AUTH_APPROVED_MESSAGE}</Alert>
            ) : null}
            {outcome?.kind === "denied" ? (
              <Alert severity="info">{CLI_AUTH_DENIED_MESSAGE}</Alert>
            ) : null}
            <TextField
              name="userCode"
              label="CLI code"
              required
              autoFocus
              fullWidth
              size="small"
              value={userCode}
              disabled={isDecided}
              onChange={(event) => {
                setUserCode(event.target.value.toUpperCase());
              }}
              placeholder="ABCD1234"
            />
            <Stack spacing={1.5}>
              <Button
                size="large"
                type="submit"
                variant="contained"
                startIcon={<CheckCircleOutlineIcon />}
                loading={isPending && pendingDecision === "approve"}
                disabled={isBusy}
              >
                Approve CLI access
              </Button>
              <Button
                size="large"
                variant="outlined"
                color="inherit"
                loading={isPending && pendingDecision === "deny"}
                disabled={isBusy}
                onClick={() => {
                  decide("deny");
                }}
              >
                Deny
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
