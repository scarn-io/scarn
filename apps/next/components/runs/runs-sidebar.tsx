"use client";

/**
 * The Runs list's sidebar: two facets, who started a run (an automation, a
 * schedule, or you) and what ran (a pipeline, a step or a Task), each entry with
 * its in-progress count and a dot when something there needs you. Every
 * entry is a link, so the facets are URL state like the rest of the list.
 */

import { Box, ButtonBase, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { ProjectRunType } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { useProjectPath } from "@/components/project-route-context";
import { KindIcon } from "./run-row-parts";
import type { RunsCounts } from "./runs-api";
import type { RunsNav } from "./runs-params";

export const RUNS_SIDEBAR_WIDTH = 240;

/** An automation as the sidebar lists it; `scope` drives the hint. */
export type RunsSidebarAutomation = {
  id: string;
  label: string;
  scope: "project" | "workItem";
};

type Facet = { inProgress: number; needsYou: boolean };

const IDLE: Facet = { inProgress: 0, needsYou: false };

export type RunsSidebarProps = {
  nav: RunsNav;
  counts: RunsCounts | null;
  automations: readonly RunsSidebarAutomation[];
  /** The list URL for a scope; every scope change clears the others. */
  scopeHref: (scope: { whatRan?: string; by?: string }) => string;
};

export function RunsSidebar({
  nav,
  counts,
  automations,
  scopeHref,
}: RunsSidebarProps) {
  const buildPath = useProjectPath();
  const [allSteps, setAllSteps] = useState(false);
  const startedBy = counts?.startedBy ?? [];
  const whatRan = counts?.whatRan ?? [];
  const facetOf = (entry: Facet | undefined): Facet => entry ?? IDLE;

  const you = startedBy.find((entry) => entry.filter === "me");
  const scheduled = startedBy.find((entry) => entry.filter === "scheduled");
  const automationEntries = [
    ...automations.map((automation) => ({
      id: automation.id,
      label: automation.label,
      hint: automation.scope === "project" ? "project" : "work item",
      facet: facetOf(startedBy.find((entry) => entry.filter === automation.id)),
    })),
    ...startedBy
      .filter(
        (entry) =>
          entry.filter !== "me" &&
          entry.filter !== "scheduled" &&
          !automations.some((automation) => automation.id === entry.filter),
      )
      .map((entry) => ({
        id: entry.filter,
        label: entry.label,
        hint: undefined,
        facet: facetOf(entry),
      })),
  ];

  const ofKind = (kind: ProjectRunType) =>
    whatRan.filter((entry) => entry.whatRan.kind === kind);
  const pipelines = ofKind("pipeline");
  const steps = ofKind("step");
  const stepsShown = allSteps
    ? steps
    : steps.filter(
        (entry) => entry.inProgress > 0 || entry.filter === nav.whatRan,
      );
  const tasks = ofKind("task")[0];
  const unscoped =
    nav.by === undefined &&
    nav.whatRan === undefined &&
    nav.item === undefined &&
    nav.schedule === undefined;

  return (
    <Box
      component="nav"
      aria-label="Runs filters"
      sx={{
        width: RUNS_SIDEBAR_WIDTH,
        flexShrink: 0,
        borderRight: 1,
        borderColor: "divider",
        overflowY: "auto",
        py: 3,
        px: 1.5,
        display: { xs: "none", md: "block" },
      }}
    >
      <SideLink
        label="All runs"
        facet={counts?.overall ?? IDLE}
        active={unscoped}
        href={scopeHref({})}
      />

      <SideHeading>Started by</SideHeading>
      {automationEntries.map((entry) => (
        <SideLink
          key={entry.id}
          label={entry.label}
          hint={entry.hint}
          facet={entry.facet}
          active={nav.by === entry.id && nav.whatRan === undefined}
          href={scopeHref({ by: entry.id })}
        />
      ))}
      {scheduled ? (
        <SideLink
          label={scheduled.label}
          facet={scheduled}
          active={nav.by === "scheduled" && nav.whatRan === undefined}
          href={scopeHref({ by: "scheduled" })}
        />
      ) : null}
      {you ? (
        <SideLink
          label="You"
          facet={you}
          active={nav.by === "me" && nav.whatRan === undefined}
          href={scopeHref({ by: "me" })}
        />
      ) : null}

      <SideHeading>What ran</SideHeading>
      {pipelines.length > 0 ? <SideGroup>Pipelines</SideGroup> : null}
      {pipelines.map((entry) => (
        <SideLink
          key={entry.filter}
          label={entry.whatRan.name}
          icon="pipeline"
          facet={entry}
          active={nav.whatRan === entry.filter}
          href={scopeHref({ whatRan: entry.filter })}
        />
      ))}
      {steps.length > 0 ? <SideGroup>Steps</SideGroup> : null}
      {stepsShown.map((entry) => (
        <SideLink
          key={entry.filter}
          label={entry.whatRan.name}
          icon="step"
          facet={entry}
          active={nav.whatRan === entry.filter}
          href={scopeHref({ whatRan: entry.filter })}
        />
      ))}
      {stepsShown.length < steps.length || allSteps ? (
        <ButtonBase
          onClick={() => {
            setAllSteps((shown) => !shown);
          }}
          sx={{ px: 1, py: 0.5, fontSize: 12, color: "text.disabled" }}
        >
          {allSteps
            ? "Hide idle steps"
            : `Show all ${String(steps.length)} steps`}
        </ButtonBase>
      ) : null}
      <SideGroup>You asked</SideGroup>
      <SideLink
        label="Tasks"
        icon="task"
        facet={facetOf(tasks)}
        active={nav.whatRan === "task"}
        href={scopeHref({ whatRan: "task" })}
      />

      <Box
        component={Link}
        href={buildPath("pipelines")}
        sx={{
          display: "block",
          px: 1,
          mt: 2,
          fontSize: 12.5,
          color: "primary.main",
          textDecoration: "none",
          "&:hover": { textDecoration: "underline" },
        }}
      >
        Pipelines & Automations →
      </Box>
    </Box>
  );
}

function SideHeading({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      component="div"
      sx={{ px: 1, mt: 2.5, mb: 0.25, color: "text.disabled", fontWeight: 600 }}
    >
      {children}
    </Typography>
  );
}

function SideGroup({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      component="div"
      sx={{ px: 1, mt: 1, color: "text.disabled", fontSize: 11 }}
    >
      {children}
    </Typography>
  );
}

function SideLink({
  label,
  hint,
  icon,
  facet,
  active,
  href,
}: {
  label: string;
  hint?: string | undefined;
  icon?: ProjectRunType;
  facet: Facet;
  active: boolean;
  href: string;
}) {
  return (
    <ButtonBase
      LinkComponent={Link}
      href={href}
      aria-current={active ? "page" : undefined}
      data-testid="runs-side-link"
      sx={{
        width: "100%",
        justifyContent: "flex-start",
        gap: 1,
        px: 1,
        py: 0.625,
        mt: 0.25,
        borderRadius: 1.5,
        fontSize: 13.5,
        textAlign: "left",
        fontWeight: active ? 600 : 400,
        color: active ? "text.primary" : "text.secondary",
        backgroundColor: active
          ? (theme) => alpha(theme.palette.text.primary, 0.08)
          : "transparent",
        "&:hover": {
          backgroundColor: (theme) => alpha(theme.palette.text.primary, 0.06),
        },
      }}
    >
      <Box
        component="span"
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {icon ? <KindIcon kind={icon} /> : null}
        {label}
        {hint ? (
          <Box
            component="span"
            sx={{ color: "text.disabled", fontSize: 11.5, ml: 0.75 }}
          >
            {hint}
          </Box>
        ) : null}
      </Box>
      {facet.needsYou ? (
        <Box
          component="span"
          title="Something here needs you"
          data-testid="needs-you-dot"
          sx={{ color: "info.main", fontSize: 9 }}
        >
          ●
        </Box>
      ) : null}
      {facet.inProgress > 0 ? (
        <Box
          component="span"
          title={`${String(facet.inProgress)} in progress`}
          sx={{ color: "text.disabled", fontSize: 12 }}
        >
          {facet.inProgress}
        </Box>
      ) : null}
    </ButtonBase>
  );
}
