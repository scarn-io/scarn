"use client";

import { useState } from "react";
import { Box, Button, Link, Stack, TextField } from "@mui/material";
import MailOutlineIcon from "@mui/icons-material/MailOutline";

type EmailMode = "sign-in" | "sign-up";

export type EmailPasswordSubmission = {
  mode: EmailMode;
  name: string;
  email: string;
  password: string;
};

/** Email/password sign-in, with a toggle to create an account instead. */
export function EmailPasswordForm({
  pending,
  disabled,
  onModeChange,
  onSubmit,
}: {
  pending: boolean;
  disabled: boolean;
  onModeChange: () => void;
  onSubmit: (submission: EmailPasswordSubmission) => void;
}) {
  const [mode, setMode] = useState<EmailMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signingUp = mode === "sign-up";

  return (
    <Box
      component="form"
      aria-label={
        signingUp ? "Create an account with email" : "Sign in with email"
      }
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ mode, name: name.trim(), email: email.trim(), password });
      }}
    >
      <Stack spacing={2}>
        {signingUp ? (
          <TextField
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            autoComplete="name"
            required
            fullWidth
            size="small"
            disabled={disabled}
          />
        ) : null}
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          autoComplete="email"
          required
          fullWidth
          size="small"
          disabled={disabled}
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          autoComplete={signingUp ? "new-password" : "current-password"}
          required
          fullWidth
          size="small"
          disabled={disabled}
        />
        <Button
          type="submit"
          size="large"
          variant="outlined"
          startIcon={<MailOutlineIcon />}
          loading={pending}
          disabled={disabled}
        >
          {signingUp ? "Create account" : "Sign in with email"}
        </Button>
        <Link
          component="button"
          type="button"
          variant="body2"
          onClick={() => {
            onModeChange();
            setMode(signingUp ? "sign-in" : "sign-up");
          }}
        >
          {signingUp
            ? "Already have an account? Sign in"
            : "New here? Create an account"}
        </Link>
      </Stack>
    </Box>
  );
}
