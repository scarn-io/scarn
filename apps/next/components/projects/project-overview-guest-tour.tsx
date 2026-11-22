"use client";

import { Box, Stack, Typography } from "@mui/material";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import Link from "next/link";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";
import {
  buildStepFocusHref,
  buildStepViewHref,
} from "@/components/executions/execution-detail-params";
import type {
  OverviewRunHighlight,
  ProjectOverviewTour,
} from "@/app/(protected)/projects/_lib/project-overview-server";

/** Mono uppercase eyebrow label. */
const EYEBROW_SX = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.6875rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  color: "text.disabled",
};

type TourCard = {
  key: string;
  eyebrow: string;
  icon: React.ReactNode;
  title: string;
  caption: string;
  href: string;
};

/** `/{username}/{slug}/runs/{id}` — the run's own page. */
const runPath = (
  username: string,
  projectSlug: string,
  highlight: OverviewRunHighlight,
): string =>
  projectSubPath(username, projectSlug, "runs", highlight.executionId);

/**
 * Deep link into the step's conversation, or the run overview when no step
 * could be resolved. Built through `execution-detail-params` so this component
 * never has to know the `?step=`/`?view=` param names.
 */
const transcriptHref = (
  username: string,
  projectSlug: string,
  highlight: OverviewRunHighlight,
): string => {
  const pathname = runPath(username, projectSlug, highlight);
  return highlight.nodeId === null
    ? pathname
    : buildStepViewHref(
        pathname,
        new URLSearchParams(),
        highlight.nodeId,
        "conversation",
      );
};

/**
 * Deep link to the step that recorded the trace, scrolled straight to its
 * Artifacts section (`focus: "artifacts"`) rather than leaving the visitor to
 * find it themselves. Stops one click short of the Playwright viewer on
 * purpose: opening a trace needs a freshly minted, short-lived download URL,
 * which a server-rendered href cannot carry. The step page expands its
 * Artifacts section for a completed step (Phase 2d), so the labeled "View
 * Playwright trace" button is already in view when the visitor lands.
 */
const traceHref = (
  username: string,
  projectSlug: string,
  highlight: OverviewRunHighlight,
): string => {
  const pathname = runPath(username, projectSlug, highlight);
  return highlight.nodeId === null
    ? pathname
    : buildStepFocusHref(
        pathname,
        new URLSearchParams(),
        highlight.nodeId,
        "artifacts",
      );
};

/**
 * Builds the tour's cards, skipping any whose target the project doesn't have.
 * A card is never rendered speculatively: an empty project produces no cards at
 * all rather than links that 404.
 */
const buildTourCards = (
  username: string,
  projectSlug: string,
  tour: ProjectOverviewTour,
): TourCard[] => {
  const cards: TourCard[] = [];

  if (tour.transcript) {
    cards.push({
      key: "transcript",
      eyebrow: "Agent transcript",
      icon: <ForumOutlinedIcon fontSize="small" />,
      title: tour.transcript.workItemTitle,
      caption:
        "Read a completed run in the agent's own words — every message, command, and finding, in the order it happened.",
      href: transcriptHref(username, projectSlug, tour.transcript),
    });
  }

  if (tour.trace) {
    cards.push({
      key: "trace",
      eyebrow: "Playwright trace",
      icon: <TravelExploreOutlinedIcon fontSize="small" />,
      title: "Watch the agent drive a real browser",
      caption:
        "This step recorded a Playwright trace while it worked: every action, screenshot, and network call. Open the step, then “View Playwright trace”.",
      href: traceHref(username, projectSlug, tour.trace),
    });
  }

  if (tour.inProgress) {
    cards.push({
      key: "in-progress",
      eyebrow: "Running right now",
      icon: <BoltOutlinedIcon fontSize="small" />,
      title: tour.inProgress.workItemTitle,
      caption:
        "A run is in flight on this project. Follow the agent's messages as they land — the page keeps itself up to date.",
      href: transcriptHref(username, projectSlug, tour.inProgress),
    });
  }

  return cards;
};

function TourCardLink({ card }: { card: TourCard }) {
  return (
    <Box
      component={Link}
      href={card.href}
      sx={{
        display: "block",
        textDecoration: "none",
        color: "inherit",
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        backgroundColor: "background.paper",
        p: 2,
        transition: "border-color 120ms ease, background-color 120ms ease",
        "&:hover": {
          borderColor: "primary.main",
          backgroundColor: "action.hover",
        },
      }}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Box sx={{ color: "text.disabled", display: "flex" }}>
            {card.icon}
          </Box>
          <Typography component="span" sx={EYEBROW_SX}>
            {card.eyebrow}
          </Typography>
        </Stack>
        <Typography variant="body1" sx={{ fontWeight: 600 }}>
          {card.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {card.caption}
        </Typography>
      </Stack>
    </Box>
  );
}

/**
 * The project root's non-member view: two or three curated cards that put the
 * project's best content one click away
 * (`docs/demo-showcase-implementation-plan.md` Phase 5a).
 *
 * A guest arriving from the landing page's CTA lands here, so the job is to
 * point at real runs rather than to summarize the project. Cards are built from
 * targets resolved server-side; any target the project doesn't have is simply
 * absent, and a project with none of them falls back to the Work Items link
 * that closes the page either way.
 */
export function ProjectOverviewGuestTour({
  username,
  projectSlug,
  tour,
}: {
  username: string;
  projectSlug: string;
  tour: ProjectOverviewTour;
}) {
  const cards = buildTourCards(username, projectSlug, tour);
  const workItemsHref = projectSubPath(username, projectSlug, "work-items");

  return (
    <Stack spacing={2}>
      {cards.length > 0 ? (
        cards.map((card) => <TourCardLink key={card.key} card={card} />)
      ) : (
        <Typography variant="body2" color="text.secondary">
          This project has no agent runs to show yet.
        </Typography>
      )}
      <Box
        component={Link}
        href={workItemsHref}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.5,
          alignSelf: "flex-start",
          color: "primary.main",
          textDecoration: "none",
          fontSize: "0.875rem",
          fontWeight: 600,
          "&:hover": { textDecoration: "underline" },
        }}
      >
        Browse every work item
        <ArrowForwardIcon fontSize="small" />
      </Box>
    </Stack>
  );
}
