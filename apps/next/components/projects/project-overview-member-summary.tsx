"use client";

import { Box, Stack, Typography } from "@mui/material";
import Link from "next/link";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";
import type { ProjectOverviewCounts } from "@/app/(protected)/projects/_lib/project-overview-server";

type SummaryTile = {
  key: string;
  label: string;
  value: number;
  href: string;
};

/**
 * The project root's member view: four counts, each a link into the tab that
 * owns the underlying list.
 *
 * Deliberately unelaborate. The plan is explicit that the member summary is not
 * the point of this page ("basic counts — nothing elaborate"); the guest tour is
 * (`docs/demo-showcase-implementation-plan.md` Phase 5a). Anything richer —
 * throughput, per-pipeline health, a run timeline — belongs to whatever plan
 * actually asks for it.
 */
export function ProjectOverviewMemberSummary({
  username,
  projectSlug,
  counts,
}: {
  username: string;
  projectSlug: string;
  counts: ProjectOverviewCounts;
}) {
  const tiles: SummaryTile[] = [
    {
      key: "work-items",
      label: counts.workItems === 1 ? "Work item" : "Work items",
      value: counts.workItems,
      href: projectSubPath(username, projectSlug, "work-items"),
    },
    {
      key: "pipelines",
      label: counts.pipelines === 1 ? "Pipeline" : "Pipelines",
      value: counts.pipelines,
      href: projectSubPath(username, projectSlug, "pipelines"),
    },
    {
      key: "executions",
      label: counts.executions === 1 ? "Run" : "Runs",
      value: counts.executions,
      href: `${projectSubPath(username, projectSlug, "runs")}?status=all`,
    },
    {
      key: "running",
      label: "Running now",
      value: counts.runningExecutions,
      href: `${projectSubPath(username, projectSlug, "runs")}?status=running`,
    },
  ];

  return (
    <Box
      sx={{
        display: "grid",
        gap: 2,
        gridTemplateColumns: {
          xs: "repeat(2, minmax(0, 1fr))",
          md: "repeat(4, minmax(0, 1fr))",
        },
      }}
    >
      {tiles.map((tile) => (
        <Box
          key={tile.key}
          component={Link}
          href={tile.href}
          sx={{
            textDecoration: "none",
            color: "inherit",
            border: 1,
            borderColor: "divider",
            borderRadius: 2,
            backgroundColor: "background.paper",
            p: 2,
            transition: "border-color 120ms ease",
            "&:hover": { borderColor: "primary.main" },
          }}
        >
          <Stack spacing={0.5}>
            <Typography
              variant="h2"
              sx={{ fontSize: "1.75rem", fontWeight: 600 }}
            >
              {tile.value}
            </Typography>
            <Typography
              component="span"
              sx={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6875rem",
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "text.disabled",
              }}
            >
              {tile.label}
            </Typography>
          </Stack>
        </Box>
      ))}
    </Box>
  );
}
