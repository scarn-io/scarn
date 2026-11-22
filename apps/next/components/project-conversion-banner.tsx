"use client";

import CloseIcon from "@mui/icons-material/Close";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useLayoutEffect, useState } from "react";
import { Alert, Button, IconButton, Stack } from "@mui/material";
import {
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
} from "@scarn/core/demo-project/demo-account";
import {
  useIsProjectMember,
  useProjectPath,
  useProjectRoute,
} from "./project-route-context";

function dismissedStorageKey(projectId: string): string {
  return `scarn:conversion-banner-dismissed:${projectId}`;
}

/**
 * What the seeded demo project's guest banner says instead of the generic
 * guest copy. Describes what the demo actually contains — a captured
 * `reproduce_in_browser` run that *reproduced* a coupon/checkout 500 and
 * recorded a Playwright trace — not a fix it never performed.
 */
const DEMO_BANNER_MESSAGE =
  "This is the live Scarn demo — a real agent reproducing a real checkout bug in a real browser, Playwright trace and full transcript included.";

/**
 * Persistent, dismissible banner shown to a non-member viewing a public
 * project — logged out, or logged in without membership (`isMember: false`,
 * issue #150). Members and owners never see it: per `ProjectRouteContext`'s
 * `isMember` doc, it's always `true` on a private project, since a
 * non-member never resolves one far enough to reach this provider.
 *
 * Dismissing persists for the rest of the browser tab's session
 * (`sessionStorage`), scoped to this project so dismissing here doesn't
 * suppress the banner on a different public project. It never blocks the
 * underlying content — it's a sibling banner, not an overlay. (issue #152)
 *
 * One project gets different copy: the seeded demo
 * (`docs/demo-showcase-implementation-plan.md` Phase 5c). This and the project
 * Overview page's guest tour are the only two places demo-specific copy is
 * allowed to live (Decision 5), and the match is made against the demo
 * constants using this route's live `username`/`projectSlug` rather than by
 * re-hardcoding `"demo"`.
 */
export function ProjectConversionBanner() {
  const isMember = useIsProjectMember();
  const { projectId, username, projectSlug } = useProjectRoute();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentUrl =
    searchParams.size > 0 ? `${pathname}?${searchParams.toString()}` : pathname;
  const tourHref = useProjectPath()("tour");
  const [dismissed, setDismissed] = useState(false);

  // The single demo-aware branch. `payoffHref` points at the project's own
  // Overview page (`/tour`), whose guest tour resolves the real deep links
  // server-side (this is a client component and must not fetch) — and is
  // `null` when the visitor is already on that page, since a CTA to the
  // current page is noise.
  const demo =
    username === DEMO_ACCOUNT_USERNAME && projectSlug === DEMO_PROJECT_SLUG
      ? {
          message: DEMO_BANNER_MESSAGE,
          payoffHref: pathname === tourHref ? null : tourHref,
        }
      : null;

  // Runs synchronously before the browser paints (unlike `useEffect`, which
  // fires after), so a previously-dismissed viewer never sees the banner
  // flash on screen before disappearing.
  useLayoutEffect(() => {
    if (sessionStorage.getItem(dismissedStorageKey(projectId)) === "1") {
      setDismissed(true);
    }
  }, [projectId]);

  if (isMember || dismissed) return null;

  const handleDismiss = () => {
    sessionStorage.setItem(dismissedStorageKey(projectId), "1");
    setDismissed(true);
  };

  return (
    <Alert
      severity="info"
      icon={false}
      sx={{ borderRadius: 0, alignItems: "center" }}
      // `Alert` only renders `onClose`'s default close button when no
      // `action` is supplied — here the action slot also needs the "Sign
      // up" CTA, so dismissal is a hand-rolled `IconButton` inside `action`
      // instead.
      action={
        <Stack direction="row" spacing={1} alignItems="center">
          {demo?.payoffHref ? (
            <Button
              component={Link}
              href={demo.payoffHref}
              color="inherit"
              size="small"
              variant="text"
            >
              See the run
            </Button>
          ) : null}
          <Button
            component={Link}
            href={`/login?callbackUrl=${encodeURIComponent(currentUrl)}`}
            color="inherit"
            size="small"
            variant="outlined"
          >
            Sign up
          </Button>
          <IconButton
            aria-label="Dismiss"
            color="inherit"
            size="small"
            onClick={handleDismiss}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
      }
    >
      {demo ? (
        demo.message
      ) : (
        <>
          You&rsquo;re viewing this project as a guest. Sign up to create and
          manage your own projects.
        </>
      )}
    </Alert>
  );
}
