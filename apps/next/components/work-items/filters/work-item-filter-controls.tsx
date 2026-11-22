"use client";

import { Box, Divider, Stack, Typography } from "@mui/material";
import type { ProjectMemberContract } from "@scarn/api/frontend-contracts";
import type { ScoreSortPipeline } from "@/components/work-items/filters/score-sort-catalog";
import type { WorkItemFieldFilterOption } from "@/app/(protected)/projects/_lib/project-work-items";
import type { WorkItemSort } from "@/components/work-items/project-work-items-params";
import { useHasProjectPermission } from "@/components/project-route-context";
import { AwaitingApprovalFilterMenu } from "@/components/work-items/filters/awaiting-approval-menu";
import { FieldFilterMenu } from "@/components/work-items/filters/field-filter-menu";
import { LabelFilterMenu } from "@/components/work-items/filters/label-filter-menu";
import {
  SingleChoiceFilterMenu,
  type SingleChoiceGroup,
} from "@/components/work-items/filters/single-choice-filter-menu";
import { SortMenu } from "@/components/work-items/filters/sort-menu";
import { UpdatedFilterMenu } from "@/components/work-items/filters/updated-filter-menu";
import {
  AGENT_FILTER_LABELS,
  LATEST_RUN_STATUS_LABELS,
  PLATFORM_LABELS,
  activeLabels,
  singleValue,
  type AssigneeFilterValue,
  type PipelineRunStatus,
  type SingleValueFilterKind,
  type SingleValueOf,
  type TimeBound,
  type WorkItemAgentFilter,
  type WorkItemFilter,
  type WorkItemPlatform,
} from "@/components/work-items/filters/work-item-filter-model";
import {
  MemberAvatar,
  memberLabel,
} from "@/components/work-items/work-item-assignee";

export type SingleValueChange = <K extends SingleValueFilterKind>(
  kind: K,
  value: SingleValueOf<K> | undefined,
) => void;

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

const optionsFromLabels = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({
    value,
    label: capitalize(labels[value]),
  }));

const AGENT_GROUPS: SingleChoiceGroup<WorkItemAgentFilter>[] = [
  { options: optionsFromLabels(AGENT_FILTER_LABELS) },
];

const LATEST_RUN_GROUPS: SingleChoiceGroup<PipelineRunStatus>[] = [
  { options: optionsFromLabels(LATEST_RUN_STATUS_LABELS) },
];

const PLATFORM_GROUPS: SingleChoiceGroup<WorkItemPlatform>[] = [
  { options: optionsFromLabels(PLATFORM_LABELS) },
];

const assigneeGroups = (
  members: readonly ProjectMemberContract[],
): SingleChoiceGroup<AssigneeFilterValue>[] => [
  {
    options: [
      { value: "me", label: "Mine" },
      { value: "none", label: "Unassigned" },
    ],
  },
  ...(members.length > 0
    ? [
        {
          heading: "Members",
          options: members.map((member) => ({
            value: member.userId,
            label: memberLabel(member),
            icon: <MemberAvatar member={member} />,
          })),
        },
      ]
    : []),
];

const activeFieldValues = (filters: WorkItemFilter[]): Map<string, string> => {
  const active = new Map<string, string>();
  for (const filter of filters) {
    if (filter.kind === "field") active.set(filter.key, filter.value);
  }
  return active;
};

const activeUpdatedBounds = (
  filters: WorkItemFilter[],
): { after?: TimeBound; before?: TimeBound } =>
  filters.find((filter) => filter.kind === "updated") ?? {};

/**
 * The control strip: what the result set currently is, and what can be added to
 * it. Fixed order, left to right, so a control stays where the user last found
 * it no matter how many clauses are active.
 *
 * A control appears only once its filter actually works. `Assignee` opens on
 * All rather than Mine: most synced items only gain a Scarn assignee once
 * their person links an account. `Awaiting approval` is served, but its button
 * is gated on `work-item-platform-comment:create` (decisions 8/9) — a caller
 * who cannot act on a draft is not offered a queue they cannot work, though
 * the clause itself still filters and charts for anyone who arrives with it
 * already in the URL. `Sort` is the one exception to "appears only once it
 * works": it always renders, even with no active pipeline, since Newest/
 * Oldest/Recently-updated need no pipeline at all (decision 5,
 * `docs/plans/work-item-sort.md`) — a project with no signals to sort by can
 * still sort by date.
 */
export function WorkItemFilterControls({
  total,
  filters,
  fieldFilterOptions,
  onFieldFilterToggle,
  labelOptions,
  onLabelToggle,
  onUpdatedChange,
  onAwaitingApprovalChange,
  onSingleValueChange,
  members,
  scoreCatalog,
  sort,
  scoreLabel,
}: {
  total: number;
  filters: WorkItemFilter[];
  fieldFilterOptions: WorkItemFieldFilterOption[];
  onFieldFilterToggle: (key: string, value: string) => void;
  labelOptions: readonly string[];
  onLabelToggle: (label: string) => void;
  onUpdatedChange: (after?: TimeBound, before?: TimeBound) => void;
  onAwaitingApprovalChange: (active: boolean) => void;
  onSingleValueChange: SingleValueChange;
  members: readonly ProjectMemberContract[];
  scoreCatalog: ScoreSortPipeline[];
  sort: WorkItemSort;
  scoreLabel: string | undefined;
}) {
  const updated = activeUpdatedBounds(filters);
  const awaitingApproval = filters.some(
    (filter) => filter.kind === "awaitingApproval",
  );
  const canApproveCommentDrafts = useHasProjectPermission(
    "work-item-platform-comment:create",
  );

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ minHeight: 34 }}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ whiteSpace: "nowrap", pr: 0.5 }}
      >
        {total === 1 ? "1 item" : `${total.toLocaleString()} items`}
      </Typography>

      <SingleChoiceFilterMenu
        label="Assignee"
        title="Assignee"
        description="Who the work item is assigned to in Scarn."
        allLabel="All"
        groups={assigneeGroups(members)}
        active={singleValue(filters, "assignee")}
        onChange={(value) => {
          onSingleValueChange("assignee", value);
        }}
      />

      <SingleChoiceFilterMenu
        label="Agent"
        title="Agent"
        description="Items with at least one Task in this state."
        groups={AGENT_GROUPS}
        active={singleValue(filters, "agent")}
        onChange={(value) => {
          onSingleValueChange("agent", value);
        }}
      />

      <UpdatedFilterMenu
        after={updated.after}
        before={updated.before}
        onChange={onUpdatedChange}
      />

      {canApproveCommentDrafts && (
        <AwaitingApprovalFilterMenu
          active={awaitingApproval}
          onChange={onAwaitingApprovalChange}
        />
      )}

      <SingleChoiceFilterMenu
        label="Latest run"
        title="Latest run"
        description="Status of the item's most recent pipeline run."
        groups={LATEST_RUN_GROUPS}
        active={singleValue(filters, "status")}
        onChange={(value) => {
          onSingleValueChange("status", value);
        }}
      />

      <SingleChoiceFilterMenu
        label="Platform"
        title="Platform"
        description="Where the work item comes from."
        groups={PLATFORM_GROUPS}
        active={singleValue(filters, "platform")}
        onChange={(value) => {
          onSingleValueChange("platform", value);
        }}
      />

      <LabelFilterMenu
        options={labelOptions}
        active={activeLabels(filters)}
        onToggle={onLabelToggle}
      />

      <FieldFilterMenu
        options={fieldFilterOptions}
        activeValueByKey={activeFieldValues(filters)}
        onToggle={onFieldFilterToggle}
      />

      <Box sx={{ flexGrow: 1 }} />

      <Divider orientation="vertical" flexItem sx={{ my: 0.75 }} />
      <SortMenu
        scoreCatalog={scoreCatalog}
        sort={sort}
        scoreLabel={scoreLabel}
      />
    </Stack>
  );
}
