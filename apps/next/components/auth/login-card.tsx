"use client";

import { useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import GitHubIcon from "@mui/icons-material/GitHub";
import GoogleIcon from "@mui/icons-material/Google";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import {
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
} from "@scarn/core/demo-project/demo-account";
import { authClient } from "@/app/_lib/auth-client";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";
import {
  EmailPasswordForm,
  type EmailPasswordSubmission,
} from "./email-password-form";

// Links straight at `/tour` rather than the project root, which now always
// redirects (`(content)/page.tsx`) — skipping that hop for the landing
// site's highest-intent CTA.
const DEMO_TOUR_PATH = projectSubPath(
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
  "tour",
);

const DEV_LOGIN_DEFAULT_EMAIL = "dev@scarn.local";

const errorMessages: Record<string, string> = {
  account_not_linked:
    "An account with that email already exists. Sign in with the original provider first to link this one.",
  unable_to_link_account:
    "We couldn't link that social account to your existing account.",
  Default: "Sign-in could not be completed.",
};

type PendingMethod = "github" | "google" | "email" | "dev" | null;

/** Why the visitor is being asked to sign in, read off where they're headed. */
export function loginContextLine(callbackUrl: string): string | null {
  if (callbackUrl.startsWith("/cli-auth")) {
    return "Sign in to connect the Scarn CLI.";
  }
  if (callbackUrl.startsWith("/invite/")) {
    return "Sign in to accept your invite.";
  }
  return null;
}

const NO_PROVIDERS_SETUP_HINT =
  "No sign-in providers are configured. Set GITHUB_APP_CLIENT_* or GOOGLE_OAUTH_* env vars, or set ENABLE_EMAIL_PASSWORD_LOGIN=true.";
const NO_PROVIDERS_UNAVAILABLE = "Sign-in is temporarily unavailable.";

export function LoginCard({
  callbackUrl,
  error,
  githubEnabled,
  googleEnabled,
  emailPasswordEnabled,
  devLoginEnabled,
  showProviderSetupHint,
  showDemoLink,
}: {
  callbackUrl: string;
  error: string | null;
  githubEnabled: boolean;
  googleEnabled: boolean;
  emailPasswordEnabled: boolean;
  devLoginEnabled: boolean;
  /** Name the env vars when no provider is configured; off in production. */
  showProviderSetupHint: boolean;
  /** Link to the seeded demo project; only when the deployment enables it. */
  showDemoLink: boolean;
}) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(
    error ? (errorMessages[error] ?? errorMessages["Default"] ?? null) : null,
  );
  const [pendingProvider, setPendingProvider] = useState<PendingMethod>(null);
  const [devEmail, setDevEmail] = useState<string>(DEV_LOGIN_DEFAULT_EMAIL);

  const onSocialClick = (provider: "github" | "google") => {
    setErrorMessage(null);
    setPendingProvider(provider);
    void authClient.signIn
      .social({
        provider,
        callbackURL: new URL(callbackUrl, window.location.origin).toString(),
      })
      .then((result) => {
        if (result.error) {
          setPendingProvider(null);
          setErrorMessage(
            errorMessages[result.error.code ?? ""] ??
              result.error.message ??
              errorMessages["Default"] ??
              null,
          );
        }
      })
      .catch(() => {
        setPendingProvider(null);
        setErrorMessage(errorMessages["Default"] ?? null);
      });
  };

  const submitEmailPassword = ({
    mode,
    name,
    email,
    password,
  }: EmailPasswordSubmission) => {
    setErrorMessage(null);
    setPendingProvider("email");
    const callbackURL = new URL(callbackUrl, window.location.origin).toString();
    const request =
      mode === "sign-up"
        ? authClient.signUp.email({ name, email, password, callbackURL })
        : authClient.signIn.email({ email, password, callbackURL });
    void request
      .then((result) => {
        if (result.error) {
          setPendingProvider(null);
          setErrorMessage(
            result.error.message ?? errorMessages["Default"] ?? null,
          );
          return;
        }
        window.location.href = callbackUrl;
      })
      .catch(() => {
        setPendingProvider(null);
        setErrorMessage(errorMessages["Default"] ?? null);
      });
  };

  const submitDevLogin = () => {
    const trimmed = devEmail.trim();
    if (trimmed.length === 0) {
      setErrorMessage("Enter an email address to sign in as.");
      return;
    }
    setErrorMessage(null);
    setPendingProvider("dev");
    void fetch("/api/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: trimmed }),
    })
      .then((response) => {
        if (!response.ok) {
          setPendingProvider(null);
          setErrorMessage(
            response.status === 400
              ? "That email doesn't look valid."
              : "Dev login failed. Is ENABLE_DEV_LOGIN=true set in your .env?",
          );
          return;
        }
        // Full reload so server components re-read the new session cookie.
        router.refresh();
        window.location.href = callbackUrl;
      })
      .catch(() => {
        setPendingProvider(null);
        setErrorMessage(errorMessages["Default"] ?? null);
      });
  };

  const anySocialEnabled = githubEnabled || googleEnabled;
  const socialIntroNames = [
    githubEnabled ? "GitHub" : null,
    googleEnabled ? "Google" : null,
  ].filter((name): name is string => name !== null);

  const introCopy = anySocialEnabled
    ? emailPasswordEnabled
      ? `Continue with ${socialIntroNames.join(" or ")}, or use your email.`
      : `Continue with ${socialIntroNames.join(" or ")}.`
    : emailPasswordEnabled
      ? "Sign in with your email and password."
      : devLoginEnabled
        ? "Local dev mode — sign in as any user by email to skip OAuth setup."
        : showProviderSetupHint
          ? NO_PROVIDERS_SETUP_HINT
          : NO_PROVIDERS_UNAVAILABLE;
  const contextLine = loginContextLine(callbackUrl);
  const otherPending = (method: PendingMethod) =>
    pendingProvider !== null && pendingProvider !== method;

  return (
    <Stack
      spacing={3}
      alignItems="center"
      sx={{ width: "100%", maxWidth: 360 }}
    >
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
          Sign in or create your account
        </Typography>
        {contextLine ? (
          <Typography variant="body2" color="text.secondary">
            {contextLine}
          </Typography>
        ) : null}
      </Stack>
      <Card sx={{ width: "100%" }}>
        <CardContent sx={{ p: 3 }}>
          <Stack spacing={3}>
            <Typography variant="body2" color="text.secondary">
              {introCopy}
            </Typography>
            {errorMessage ? (
              <Alert severity="error">{errorMessage}</Alert>
            ) : null}
            {anySocialEnabled || emailPasswordEnabled || devLoginEnabled ? (
              <Stack spacing={2}>
                {githubEnabled ? (
                  <Button
                    size="large"
                    variant="outlined"
                    startIcon={<GitHubIcon />}
                    onClick={() => {
                      onSocialClick("github");
                    }}
                    loading={pendingProvider === "github"}
                    disabled={otherPending("github")}
                  >
                    Continue with GitHub
                  </Button>
                ) : null}
                {googleEnabled ? (
                  <Button
                    size="large"
                    variant="outlined"
                    startIcon={<GoogleIcon />}
                    onClick={() => {
                      onSocialClick("google");
                    }}
                    loading={pendingProvider === "google"}
                    disabled={otherPending("google")}
                  >
                    Continue with Google
                  </Button>
                ) : null}
                {emailPasswordEnabled ? (
                  <>
                    {anySocialEnabled ? (
                      <Divider sx={{ fontSize: 12, color: "text.secondary" }}>
                        or
                      </Divider>
                    ) : null}
                    <EmailPasswordForm
                      pending={pendingProvider === "email"}
                      disabled={otherPending("email")}
                      onModeChange={() => {
                        setErrorMessage(null);
                      }}
                      onSubmit={submitEmailPassword}
                    />
                  </>
                ) : null}
                {devLoginEnabled ? (
                  <>
                    {anySocialEnabled || emailPasswordEnabled ? (
                      <Divider sx={{ fontSize: 12, color: "text.secondary" }}>
                        dev only
                      </Divider>
                    ) : null}
                    <Box
                      component="form"
                      aria-label="Dev login"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitDevLogin();
                      }}
                    >
                      <Stack spacing={2}>
                        <TextField
                          label="Email"
                          type="email"
                          value={devEmail}
                          onChange={(event) => {
                            setDevEmail(event.target.value);
                          }}
                          placeholder={DEV_LOGIN_DEFAULT_EMAIL}
                          autoComplete="email"
                          fullWidth
                          size="small"
                          disabled={otherPending("dev")}
                          helperText="Sign in as any user — they'll be created on the fly if new."
                        />
                        <Button
                          type="submit"
                          size="large"
                          variant="outlined"
                          color="warning"
                          startIcon={<PersonOutlineIcon />}
                          loading={pendingProvider === "dev"}
                          disabled={otherPending("dev")}
                        >
                          Sign in as this user
                        </Button>
                      </Stack>
                    </Box>
                  </>
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        </CardContent>
      </Card>
      {showDemoLink ? (
        <Typography variant="body2" color="text.secondary">
          Just want to look around?{" "}
          <Link component={NextLink} href={DEMO_TOUR_PATH}>
            See the demo project
          </Link>
        </Typography>
      ) : null}
    </Stack>
  );
}
