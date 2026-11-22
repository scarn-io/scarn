"use client";

import LogoutIcon from "@mui/icons-material/Logout";
import ManageAccountsIcon from "@mui/icons-material/ManageAccounts";
import Image from "next/image";
import Link from "next/link";
import {
  AppBar,
  Avatar,
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import * as analytics from "@scarn/observability/analytics/browser";
import { authClient } from "@/app/_lib/auth-client";
import {
  AppShellProvider,
  useAppShellOrgId,
  useAppShellOwnerUsername,
  useAppShellTitle,
} from "./app-shell-context";
import { getUserInitials } from "./user-initials";

type AppShellUser = {
  id: string;
  email: string | null | undefined;
  // Optional + nullable: un-onboarded users have no username yet.
  username?: string | null | undefined;
  name: string | null | undefined;
  image?: string | null | undefined;
};

function AppShellProfileMenu({
  userName,
  userUsername,
  userEmail,
  userImage,
}: {
  userName: string | null | undefined;
  userUsername: string | null | undefined;
  userEmail: string | null | undefined;
  userImage: string | null | undefined;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      analytics.reset();
      window.location.assign("/login");
    } finally {
      setIsSigningOut(false);
      setAnchorEl(null);
    }
  };

  return (
    <>
      <IconButton
        color="inherit"
        aria-label="Open profile menu"
        aria-controls={anchorEl ? "app-shell-profile-menu" : undefined}
        aria-expanded={anchorEl ? "true" : undefined}
        aria-haspopup="menu"
        onClick={(event) => {
          setAnchorEl(event.currentTarget);
        }}
      >
        <Avatar
          src={userImage ?? undefined}
          alt={userName ?? userUsername ?? "User profile"}
          sx={{
            bgcolor: "color-mix(in srgb, var(--color-accent) 22%, transparent)",
            color: "primary.main",
            width: 28,
            height: 28,
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid rgba(240, 246, 252, 0.12)",
          }}
        >
          {userImage ? null : getUserInitials(userUsername, userName)}
        </Avatar>
      </IconButton>
      <Menu
        id="app-shell-profile-menu"
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => {
          if (!isSigningOut) setAnchorEl(null);
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {userName || userEmail ? (
          <Box sx={{ px: 2, py: 1.25, minWidth: 220 }}>
            {userName ? (
              <Typography sx={{ fontWeight: 600, fontSize: 14 }}>
                {userName}
              </Typography>
            ) : null}
            {userEmail ? (
              <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
                {userEmail}
              </Typography>
            ) : null}
          </Box>
        ) : null}
        {userName || userEmail ? <Divider /> : null}
        <MenuItem
          component={Link}
          href="/account/settings"
          onClick={() => {
            setAnchorEl(null);
          }}
        >
          <ListItemIcon>
            <ManageAccountsIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Account settings</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={isSigningOut}
          onClick={() => {
            void handleSignOut();
          }}
        >
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>
            {isSigningOut ? "Signing out…" : "Sign out"}
          </ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}

function AppShellContent({
  children,
  initialUser,
}: {
  children: React.ReactNode;
  initialUser?: AppShellUser | null;
}) {
  const title = useAppShellTitle();
  const orgId = useAppShellOrgId();
  const ownerUsername = useAppShellOwnerUsername();
  const { data: session } = authClient.useSession();
  const user = session?.user ?? initialUser ?? null;
  const userId = user?.id;
  const userEmail = user?.email;
  const userUsername = user?.username;
  const userName = user?.name;
  const userImage = user?.image;

  useEffect(() => {
    if (!userId) return;
    analytics.identify(userId, { email: userEmail });
  }, [userId, userEmail]);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        overflow: "hidden",
      }}
    >
      <AppBar position="static" elevation={0} sx={{ flexShrink: 0 }}>
        <Toolbar sx={{ minHeight: { xs: 56, sm: 56 } }}>
          <Stack
            direction="row"
            spacing={1.25}
            alignItems="center"
            sx={{ flexGrow: 1, minWidth: 0 }}
          >
            <Image
              src="/brand-icon.svg"
              alt="scarn logo"
              width={26}
              height={26}
              style={{
                display: "block",
                borderRadius: "18%",
                boxShadow:
                  "0 4px 12px -2px color-mix(in srgb, var(--color-accent) 30%, transparent)",
              }}
            />
            <Typography
              component={Link}
              href="/"
              sx={{
                fontWeight: 600,
                fontSize: 14,
                color: "inherit",
                textDecoration: "none",
                borderRadius: 1,
                px: 0.75,
                py: 0.5,
                "&:hover": { backgroundColor: "var(--color-bg-hover)" },
              }}
            >
              scarn
            </Typography>
            {ownerUsername && orgId && (
              <>
                <Typography
                  component="span"
                  aria-hidden
                  sx={{
                    color: "text.disabled",
                    fontSize: 14,
                    userSelect: "none",
                  }}
                >
                  /
                </Typography>
                <Typography
                  component={Link}
                  href={`/organizations/${orgId}/settings`}
                  sx={{
                    fontWeight: 400,
                    fontSize: 14,
                    color: "text.primary",
                    textDecoration: "none",
                    borderRadius: 1,
                    px: 0.75,
                    py: 0.5,
                    whiteSpace: "nowrap",
                    "&:hover": { backgroundColor: "var(--color-bg-hover)" },
                  }}
                >
                  {ownerUsername}
                </Typography>
              </>
            )}
            {title && (
              <>
                <Typography
                  component="span"
                  aria-hidden
                  sx={{
                    color: "text.disabled",
                    fontSize: 14,
                    userSelect: "none",
                  }}
                >
                  /
                </Typography>
                <Typography
                  sx={{
                    fontWeight: 600,
                    fontSize: 14,
                    color: "text.primary",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {title}
                </Typography>
              </>
            )}
          </Stack>
          {user ? (
            <AppShellProfileMenu
              userName={userName}
              userUsername={userUsername}
              userEmail={userEmail}
              userImage={userImage}
            />
          ) : (
            // A non-member public-project viewer (issue #150) has no session
            // at all — there's nothing for a profile menu to show, and
            // "Sign out" would be nonsensical.
            <Button
              component={Link}
              href="/login"
              color="inherit"
              variant="outlined"
              size="small"
              sx={{ borderColor: "rgba(240, 246, 252, 0.24)" }}
            >
              Log in
            </Button>
          )}
        </Toolbar>
      </AppBar>
      <Box
        component="main"
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

export function AppShell({
  children,
  initialUser,
}: {
  children: React.ReactNode;
  initialUser?: AppShellUser | null;
}) {
  return (
    <AppShellProvider>
      <AppShellContent initialUser={initialUser}>{children}</AppShellContent>
    </AppShellProvider>
  );
}
