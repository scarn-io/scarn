"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import { useRouter } from "next/navigation";
import { authClient } from "@/app/_lib/auth-client";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";
import type { PublicInviteDetails } from "@scarn/core/projects/project-invite/contracts/project-invite-contracts";
import { formatProjectPermission } from "@scarn/api/frontend-contracts";
import { projectRoleLabel } from "@/app/_lib/project-membership";

type SessionUser = {
  email: string;
};

export type InviteAcceptPanelProps = {
  token: string;
  invite: PublicInviteDetails;
  sessionUser: SessionUser | null;
};

export function InviteAcceptPanel({
  token,
  invite,
  sessionUser,
}: InviteAcceptPanelProps) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [emailMismatch, setEmailMismatch] = useState(false);
  const [isPending, startTransition] = useTransition();
  // The accept request runs as a plain awaited async call (not inside a
  // `startTransition`): wrapping an async network call in a transition lets
  // React tear the callback down when the invitee returns from the login
  // redirect, which intermittently aborts the in-flight POST and leaves the
  // invite stuck as pending. A manual submitting flag keeps the button state.
  const [isAccepting, setIsAccepting] = useState(false);
  const isSpecificEmailInvite = invite.restriction === "specific_email";

  const loginUrl = `/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`;

  const expiresDate = new Date(invite.expiresAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const signOutAndRedirect = () => {
    startTransition(async () => {
      await authClient.signOut();
      router.push(loginUrl);
    });
  };

  const handleAccept = async () => {
    setErrorMessage(null);
    setEmailMismatch(false);
    setIsAccepting(true);
    const client = getBrowserScarnApiClient();
    const { error } = await client.api["project-invites"]({
      token,
    }).accept.post();
    if (error) {
      const err = error as { value?: { status?: number; detail?: string } };
      const status = err.value?.status;
      if (status === 403) {
        setEmailMismatch(true);
        setIsAccepting(false);
        return;
      }
      if (status === 401) {
        router.push(loginUrl);
        return;
      }
      const detail = err.value?.detail;
      setErrorMessage(detail ?? "Could not accept the invite. Try again.");
      setIsAccepting(false);
      return;
    }
    // Restore the pre-migration UX: land the new member on the project's
    // work-items page at its pretty URL `/{ownerUsername}/{projectSlug}`,
    // built from the live read-model data on the invite (never a cached
    // string). Fall back to the dashboard if the owner username could not be
    // resolved, so nothing crashes. Leave `isAccepting` set so the button
    // stays busy through the navigation.
    if (invite.ownerUsername) {
      router.push(
        projectSubPath(invite.ownerUsername, invite.projectSlug, "work-items"),
      );
    } else {
      router.push("/");
    }
  };

  const inviteSummary = (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="overline" color="text.secondary">
          Project Invite
        </Typography>
        <Typography variant="h6">{invite.projectName}</Typography>
      </Stack>
      <Divider />
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" color="text.secondary">
          You&apos;ve been invited as
        </Typography>
        <Chip size="small" label={projectRoleLabel(invite.role)} />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {isSpecificEmailInvite
          ? "Only the invited email address can accept this link."
          : "This is a single-use link. The first signed-in user who accepts it will join the project."}
      </Typography>
      {invite.permissions.length > 0 ? (
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Permissions
          </Typography>
          <List dense disablePadding>
            {invite.permissions.map((permission) => (
              <ListItem key={permission} disableGutters sx={{ py: 0.25 }}>
                <ListItemText
                  primary={formatProjectPermission(permission)}
                  slotProps={{ primary: { variant: "body2" } }}
                />
              </ListItem>
            ))}
          </List>
        </Stack>
      ) : null}
      <Typography variant="caption" color="text.secondary">
        This invite expires on {expiresDate}.
      </Typography>
    </Stack>
  );

  // Signed out — show summary and sign-in CTA
  if (!sessionUser) {
    return (
      <Card variant="outlined" sx={{ maxWidth: 480, mx: "auto" }}>
        <CardContent>
          <Stack spacing={2}>
            {inviteSummary}
            <Button
              variant="contained"
              onClick={() => {
                router.push(loginUrl);
              }}
              fullWidth
            >
              Sign in to accept this invite
            </Button>
          </Stack>
        </CardContent>
      </Card>
    );
  }

  // Email mismatch detected after attempted accept
  if (emailMismatch && isSpecificEmailInvite) {
    return (
      <Card variant="outlined" sx={{ maxWidth: 480, mx: "auto" }}>
        <CardContent>
          <Stack spacing={2}>
            <Alert severity="warning">
              This invite was sent to a different email address. You are
              currently signed in as <strong>{sessionUser.email}</strong>. Sign
              out and sign in with the correct account to accept it.
            </Alert>
            <Button
              variant="outlined"
              onClick={signOutAndRedirect}
              disabled={isPending}
              fullWidth
            >
              Sign out and try again
            </Button>
          </Stack>
        </CardContent>
      </Card>
    );
  }

  // Signed in — show accept UI
  return (
    <Card variant="outlined" sx={{ maxWidth: 480, mx: "auto" }}>
      <CardContent>
        <Stack spacing={2}>
          {inviteSummary}
          {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
          <Button
            variant="contained"
            onClick={() => {
              void handleAccept();
            }}
            loading={isAccepting}
            fullWidth
          >
            Accept Invite
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
