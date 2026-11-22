"use client";

/**
 * The header every run's page shares: a breadcrumb back to the Runs list
 * and what ran, the run's title with its status pill and outcome, and a
 * caption (parent › key · steps so far · places at once · who started it ·
 * when it last changed). It reads the run's Runs-list row, so a run never
 * looks different here and in the list.
 */

import { Box, Link as MuiLink, Stack, Typography } from "@mui/material";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { formatDateTime } from "@/components/executions/format-datetime";
import { useProjectPath } from "@/components/project-route-context";
import { KindIcon, compactAge, startedByText } from "./run-row-parts";
import { OutcomeChip, StatusPill } from "./run-status";
import type { ProjectRun } from "./runs-api";
import { useRunsBackTarget } from "./runs-back-target";

export type RunHeaderProps = {
  /** The run's Runs-list row; `null` while it loads. */
  run: ProjectRun | null;
  /** The signed-in viewer, so their own runs read "started by you". */
  viewerUserId: string | null;
  /** A pipeline run's visits so far; the part is hidden when absent. */
  stepsSoFar?: number | undefined;
  /** A pipeline run's open visits; shown only when more than one. */
  placesAtOnce?: number | undefined;
  /** Controls at the end of the title row (e.g. End, Cancel). */
  actions?: ReactNode;
  /** The title shown with the actions while the row is not loaded. */
  fallbackTitle?: string | undefined;
};

/** "updated just now", "updated 5m ago", "updated Jun 24". */
export function updatedText(value: string, now: number = Date.now()): string {
  const age = compactAge(value, now);
  if (age === "now") return "updated just now";
  return /^\d+[mhd]$/.test(age) ? `updated ${age} ago` : `updated ${age}`;
}

/** The caption's parts, in order, each a node. */
function captionParts(
  props: RunHeaderProps & { run: ProjectRun },
  workItemHref: (id: string) => string,
): ReactNode[] {
  const { run, viewerUserId, stepsSoFar, placesAtOnce } = props;
  const parts: ReactNode[] = [];
  if (run.workItem) {
    const { parent } = run.workItem;
    parts.push(
      <Box component="span" key="item">
        {parent ? (
          <>
            <CrumbLink href={workItemHref(parent.id)} title={parent.title}>
              {parent.platformKey}
            </CrumbLink>
            {" › "}
          </>
        ) : null}
        <CrumbLink
          href={workItemHref(run.workItem.id)}
          title={run.workItem.title}
        >
          {run.workItem.platformKey}
        </CrumbLink>
      </Box>,
    );
  }
  if (stepsSoFar !== undefined) {
    parts.push(
      `${String(stepsSoFar)} ${stepsSoFar === 1 ? "step" : "steps"} so far`,
    );
  }
  if (placesAtOnce !== undefined && placesAtOnce > 1) {
    parts.push(`in ${String(placesAtOnce)} places at once`);
  }
  parts.push(`started by ${startedByText(run.startedBy, viewerUserId)}`);
  parts.push(
    <Box
      component="time"
      key="updated"
      dateTime={run.updatedAt}
      title={formatDateTime(run.updatedAt)}
    >
      {updatedText(run.updatedAt)}
    </Box>,
  );
  return parts;
}

function CrumbLink({
  href,
  title,
  children,
}: {
  href: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <MuiLink
      component={Link}
      href={href}
      title={title}
      underline="hover"
      sx={{ color: "primary.main" }}
    >
      {children}
    </MuiLink>
  );
}

export function RunHeader(props: RunHeaderProps) {
  const { run, actions, fallbackTitle } = props;
  const projectPath = useProjectPath();
  const back = useRunsBackTarget();
  const workItemHref = (id: string) => projectPath("work-items", id);

  return (
    <Box
      component="header"
      data-testid="run-header"
      sx={{
        flexShrink: 0,
        px: { xs: 2, md: 3 },
        pt: 1.5,
        pb: 1.25,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Typography
        component="nav"
        aria-label="Breadcrumb"
        variant="body2"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          minWidth: 0,
          color: "text.secondary",
        }}
      >
        <CrumbLink href={back.href}>← {back.label}</CrumbLink>
        {run ? (
          <>
            <Box component="span" aria-hidden sx={{ color: "text.disabled" }}>
              ›
            </Box>
            <Box
              component="span"
              data-testid="run-header-what-ran"
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <KindIcon kind={run.type} />
              {run.whatRan.name}
            </Box>
          </>
        ) : null}
      </Typography>
      {run ? (
        <>
          <Stack
            direction="row"
            alignItems="center"
            flexWrap="wrap"
            useFlexGap
            columnGap={1.5}
            rowGap={0.5}
            sx={{ mt: 0.75 }}
          >
            <Typography
              component="h1"
              noWrap
              title={run.title}
              sx={{ fontSize: 19, fontWeight: 600, minWidth: 0 }}
            >
              {run.title}
            </Typography>
            <StatusPill status={run.status} />
            <OutcomeChip status={run.status} outcome={run.outcome} />
            {actions ? (
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ ml: "auto" }}
              >
                {actions}
              </Stack>
            ) : null}
          </Stack>
          <Typography
            variant="caption"
            component="div"
            data-testid="run-header-caption"
            sx={{ color: "text.disabled", mt: 0.25 }}
          >
            {captionParts({ ...props, run }, workItemHref).map(
              (part, index) => (
                <Fragment key={index}>
                  {index > 0 ? " · " : null}
                  {part}
                </Fragment>
              ),
            )}
          </Typography>
        </>
      ) : fallbackTitle !== undefined || actions ? (
        <Stack
          direction="row"
          alignItems="center"
          columnGap={1.5}
          sx={{ mt: 0.75 }}
        >
          {fallbackTitle !== undefined ? (
            <Typography
              component="h1"
              noWrap
              title={fallbackTitle}
              sx={{ fontSize: 19, fontWeight: 600, minWidth: 0 }}
            >
              {fallbackTitle}
            </Typography>
          ) : null}
          {actions ? (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ ml: "auto" }}
            >
              {actions}
            </Stack>
          ) : null}
        </Stack>
      ) : null}
    </Box>
  );
}
