"use client";

import { use, useEffect, useState } from "react";
import { Box, Card, CardContent, Link, Stack, Typography } from "@mui/material";
import NextLink from "next/link";
import { authClient } from "@/app/_lib/auth-client";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import type { PublicInviteDetails } from "@scarn/core/projects/project-invite/contracts/project-invite-contracts";
import { InviteAcceptPanel } from "./invite-accept-panel";

type InviteFetchState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "loaded"; invite: PublicInviteDetails };

export default function InviteTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [state, setState] = useState<InviteFetchState>({ status: "loading" });
  const { data: session } = authClient.useSession();

  useEffect(() => {
    let isCancelled = false;

    const loadInvite = async () => {
      const scarnApiClient = getBrowserScarnApiClient();
      const { data: invite, error } = await scarnApiClient.api[
        "project-invites"
      ]({ token }).get();

      if (isCancelled) {
        return;
      }

      if (error ?? !invite) {
        setState({ status: "not-found" });
        return;
      }

      setState({ status: "loaded", invite });
    };

    void loadInvite();

    return () => {
      isCancelled = true;
    };
  }, [token]);

  if (state.status === "loading") {
    return (
      <InvitePageShell>
        <Card variant="outlined" sx={{ maxWidth: 480, mx: "auto" }}>
          <CardContent>
            <Typography variant="body2" color="text.secondary">
              Loading invite...
            </Typography>
          </CardContent>
        </Card>
      </InvitePageShell>
    );
  }

  if (state.status === "not-found") {
    return (
      <InvitePageShell>
        <Card variant="outlined" sx={{ maxWidth: 480, mx: "auto" }}>
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="h6">Invite not found or expired</Typography>
              <Typography variant="body2" color="text.secondary">
                This invite link is invalid or has already expired. Ask the
                project owner to send you a new invite.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </InvitePageShell>
    );
  }

  const { invite } = state;

  // Invite is expired
  if (invite.status === "expired") {
    return (
      <InvitePageShell>
        <Card variant="outlined" sx={{ maxWidth: 480, mx: "auto" }}>
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="h6">This invite has expired</Typography>
              <Typography variant="body2" color="text.secondary">
                The invite to <strong>{invite.projectName}</strong> is no
                longer valid. Ask the project owner to send a new invite.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </InvitePageShell>
    );
  }

  // Invite was revoked
  if (invite.status === "revoked") {
    return (
      <InvitePageShell>
        <Card variant="outlined" sx={{ maxWidth: 480, mx: "auto" }}>
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="h6">This invite has been revoked</Typography>
              <Typography variant="body2" color="text.secondary">
                The invite to <strong>{invite.projectName}</strong> was
                revoked. Contact the project owner if you think this is a
                mistake.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </InvitePageShell>
    );
  }

  // Invite was already accepted
  if (invite.status === "accepted") {
    return (
      <InvitePageShell>
        <Card variant="outlined" sx={{ maxWidth: 480, mx: "auto" }}>
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="h6">
                This invite has already been accepted
              </Typography>
              <Typography variant="body2" color="text.secondary">
                The invite to <strong>{invite.projectName}</strong> has
                already been used.{" "}
                <Link component={NextLink} href="/">
                  Go to your dashboard
                </Link>
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </InvitePageShell>
    );
  }

  // Invite is pending — check session for interactive states
  const sessionUser = session
    ? { email: session.user.email }
    : null;

  return (
    <InvitePageShell>
      <InviteAcceptPanel
        token={token}
        invite={invite}
        sessionUser={sessionUser}
      />
    </InvitePageShell>
  );
}

function InvitePageShell({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 2,
        py: 4,
      }}
    >
      <Stack spacing={2} sx={{ width: "100%", maxWidth: 520 }}>
        <Typography variant="subtitle2" color="text.secondary" align="center">
          scarn
        </Typography>
        {children}
      </Stack>
    </Box>
  );
}
