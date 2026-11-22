"use client";

/**
 * The step Details drawer's "Route" section for a step visit: the routes it
 * took (by label), the conditions it checked, past overrules, and the
 * Overrule button. The run page provides what it needs through
 * `OverruleProvider`, so the step page and drawer don't thread it through.
 */

import { Box, Button, Stack, Typography } from "@mui/material";
import { createContext, useContext, type ReactNode } from "react";
import type {
  NodeVisitContract,
  PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import {
  useIsProjectMember,
  useProjectRoute,
} from "@/components/project-route-context";
import { useProjectMembers } from "@/components/work-items/use-project-members";
import { formatDateTime } from "./format-datetime";
import {
  describeCondition,
  describeRoutes,
  nodeNext,
  readVisitRouting,
  routeChoices,
  type RouteChoice,
  type RouteOverruleRecord,
} from "./overrule-routes";
import { Muted, Section } from "./step-details-parts";

export type OverruleContextValue = {
  version: PipelineVersionContract | null;
  viewerUserId: string | null;
  /** Whether the viewer may overrule this visit now (see `canOverruleVisit`). */
  canOverrule: (visit: NodeVisitContract) => boolean;
  openOverrule: (visit: NodeVisitContract) => void;
};

const OverruleContext = createContext<OverruleContextValue | null>(null);

export function OverruleProvider({
  value,
  children,
}: {
  value: OverruleContextValue;
  children: ReactNode;
}) {
  return (
    <OverruleContext.Provider value={value}>
      {children}
    </OverruleContext.Provider>
  );
}

function CheckedConditions({
  visit,
  choices,
}: {
  visit: NodeVisitContract;
  choices: readonly RouteChoice[];
}) {
  const checked = readVisitRouting(visit.routing)?.checked ?? [];
  const withCondition = checked.filter((entry) => entry.when !== null);
  if (withCondition.length === 0) return null;
  return (
    <Stack spacing={0.5} sx={{ mt: 1.5 }}>
      <Typography variant="caption" color="text.secondary">
        Conditions checked
      </Typography>
      {withCondition.map((entry) => {
        const label =
          choices.find(
            (choice) => choice.kind === "route" && choice.index === entry.index,
          )?.label ?? `Route ${String(entry.index + 1)}`;
        return (
          <Typography
            key={entry.index}
            variant="body2"
            sx={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
          >
            {label}:{" "}
            {entry.when ? describeCondition(entry.when) : "no condition"} →{" "}
            {entry.matched ? "true" : "false"}
          </Typography>
        );
      })}
    </Stack>
  );
}

function PastOverrules({
  overrules,
  choices,
  viewerUserId,
}: {
  overrules: readonly RouteOverruleRecord[];
  choices: readonly RouteChoice[];
  viewerUserId: string | null;
}) {
  const { projectId } = useProjectRoute();
  const isMember = useIsProjectMember();
  const { members } = useProjectMembers(projectId, isMember);
  const nameOf = (userId: string) =>
    userId === viewerUserId
      ? "You"
      : (members.find((member) => member.userId === userId)?.username ??
        "Someone");
  return (
    <Stack spacing={1} sx={{ mt: 1.5 }}>
      <Typography variant="caption" color="text.secondary">
        Overruled
      </Typography>
      {overrules.map((overrule) => (
        <Box key={`${overrule.at}:${overrule.byUserId}`}>
          <Typography variant="body2">
            {nameOf(overrule.byUserId)} · {formatDateTime(overrule.at)}:{" "}
            {describeRoutes(choices, overrule.from)} →{" "}
            {describeRoutes(choices, overrule.to)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            “{overrule.reason}”
          </Typography>
          {overrule.missingArgs.length > 0 ? (
            <Typography variant="caption" color="text.secondary">
              Continued without{" "}
              {overrule.missingArgs.map((missing) => missing.arg).join(", ")}
            </Typography>
          ) : null}
        </Box>
      ))}
    </Stack>
  );
}

/** The Route section, for a step visit that has routed; nothing outside an `OverruleProvider`. */
export function RouteSection({ visit }: { visit: NodeVisitContract }) {
  const context = useContext(OverruleContext);
  const routing = readVisitRouting(visit.routing);
  if (!context || visit.nodeKind !== "step" || routing === null) return null;
  const choices = routeChoices(
    context.version,
    nodeNext(context.version, visit.nodeId),
  );
  return (
    <Section title="Route">
      {routing.taken === null ? (
        <Muted>No route was taken.</Muted>
      ) : (
        <Typography variant="body2">
          Took {describeRoutes(choices, routing.taken)}
        </Typography>
      )}
      <CheckedConditions visit={visit} choices={choices} />
      {routing.overrules.length > 0 ? (
        <PastOverrules
          overrules={routing.overrules}
          choices={choices}
          viewerUserId={context.viewerUserId}
        />
      ) : null}
      {context.canOverrule(visit) ? (
        <Button
          size="small"
          variant="outlined"
          sx={{ mt: 1.5, textTransform: "none" }}
          onClick={() => {
            context.openOverrule(visit);
          }}
        >
          Overrule…
        </Button>
      ) : null}
    </Section>
  );
}
