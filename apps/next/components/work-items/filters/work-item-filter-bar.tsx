"use client";

import { Box, Divider } from "@mui/material";
import type { ProjectMemberContract } from "@scarn/api/frontend-contracts";
import { useCallback } from "react";
import type { ScoreSortPipeline } from "@/components/work-items/filters/score-sort-catalog";
import type { WorkItemFieldFilterOption } from "@/app/(protected)/projects/_lib/project-work-items";
import type { WorkItemSort } from "@/components/work-items/project-work-items-params";
import { WorkItemFilterChips } from "@/components/work-items/filters/work-item-filter-chips";
import {
  WorkItemFilterControls,
  type SingleValueChange,
} from "@/components/work-items/filters/work-item-filter-controls";
import {
  withLabelToggled,
  withSingleValue,
  type TimeBound,
  type WorkItemFilter,
} from "@/components/work-items/filters/work-item-filter-model";
import { useCommitFilters } from "@/components/work-items/filters/use-commit-filters";

/**
 * The work items filter bar: a chip line showing everything that is active, and
 * a control strip offering everything that is available.
 *
 * Two rows, and exactly two rows however many clauses are set — the chip line
 * scrolls rather than wrapping. That is the whole point of the split: the
 * control strip keeps a fixed position on screen, so its buttons can be found
 * by muscle memory instead of by reading.
 *
 * Tinted like `RecordList`'s header so the bar reads as the table's own header
 * rather than a toolbar floating above it.
 */
export function WorkItemFilterBar({
  filters,
  total,
  scoreCatalog,
  sort,
  scoreLabel,
  fieldFilterOptions,
  labelOptions,
  members,
}: {
  filters: WorkItemFilter[];
  total: number;
  scoreCatalog: ScoreSortPipeline[];
  sort: WorkItemSort;
  scoreLabel: string | undefined;
  fieldFilterOptions: WorkItemFieldFilterOption[];
  labelOptions: readonly string[];
  members: readonly ProjectMemberContract[];
}) {
  const commitFilters = useCommitFilters();

  const searchText =
    filters.find((filter) => filter.kind === "text")?.value ?? "";

  const handleCommitText = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      const rest = filters.filter((filter) => filter.kind !== "text");
      commitFilters(
        trimmed.length > 0 ? [...rest, { kind: "text", value: trimmed }] : rest,
      );
    },
    [commitFilters, filters],
  );

  const handleRemoveFilter = useCallback(
    (target: WorkItemFilter) => {
      commitFilters(filters.filter((filter) => filter !== target));
    },
    [commitFilters, filters],
  );

  const handleClearFilters = useCallback(() => {
    commitFilters([]);
  }, [commitFilters]);

  // One value per key today, so choosing a second value for a key replaces the
  // first rather than widening it to an OR. Re-choosing the active value clears
  // the clause, which is what the checkbox in the popover is promising.
  const handleFieldFilterToggle = useCallback(
    (key: string, value: string) => {
      const rest = filters.filter(
        (filter) => filter.kind !== "field" || filter.key !== key,
      );
      const alreadySet = filters.some(
        (filter) =>
          filter.kind === "field" &&
          filter.key === key &&
          filter.value === value,
      );
      commitFilters(
        alreadySet ? rest : [...rest, { kind: "field", key, value }],
      );
    },
    [commitFilters, filters],
  );

  const handleLabelToggle = useCallback(
    (label: string) => {
      commitFilters(withLabelToggled(filters, label));
    },
    [commitFilters, filters],
  );

  // One `updated` clause at a time: the two bounds are the two ends of a single
  // window, so a second clause could only contradict the first.
  const handleUpdatedChange = useCallback(
    (after?: TimeBound, before?: TimeBound) => {
      const rest = filters.filter((filter) => filter.kind !== "updated");
      commitFilters(
        after || before ? [...rest, { kind: "updated", after, before }] : rest,
      );
    },
    [commitFilters, filters],
  );

  // A boolean toggle rather than a diff: choosing the active item clears it,
  // matching every other menu's "re-select to remove" convention.
  const handleAwaitingApprovalChange = useCallback(
    (active: boolean) => {
      const rest = filters.filter(
        (filter) => filter.kind !== "awaitingApproval",
      );
      commitFilters(active ? [...rest, { kind: "awaitingApproval" }] : rest);
    },
    [commitFilters, filters],
  );

  const handleSingleValueChange = useCallback<SingleValueChange>(
    (kind, value) => {
      commitFilters(withSingleValue(filters, kind, value));
    },
    [commitFilters, filters],
  );

  const memberName = useCallback(
    (userId: string) =>
      members.find((member) => member.userId === userId)?.username ?? undefined,
    [members],
  );

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        overflow: "hidden",
        backgroundColor: "action.hover",
      }}
    >
      <Box sx={{ px: 1.5, py: 1.25 }}>
        <WorkItemFilterChips
          filters={filters}
          memberName={memberName}
          searchText={searchText}
          onCommitText={handleCommitText}
          onRemoveFilter={handleRemoveFilter}
          onClearFilters={handleClearFilters}
        />
      </Box>
      <Divider />
      <Box sx={{ px: 1.5, py: 0.5 }}>
        <WorkItemFilterControls
          total={total}
          filters={filters}
          fieldFilterOptions={fieldFilterOptions}
          onFieldFilterToggle={handleFieldFilterToggle}
          labelOptions={labelOptions}
          onLabelToggle={handleLabelToggle}
          onUpdatedChange={handleUpdatedChange}
          onAwaitingApprovalChange={handleAwaitingApprovalChange}
          onSingleValueChange={handleSingleValueChange}
          members={members}
          scoreCatalog={scoreCatalog}
          sort={sort}
          scoreLabel={scoreLabel}
        />
      </Box>
    </Box>
  );
}
