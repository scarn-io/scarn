"use client";

import { useState } from "react";
import { Box, ButtonBase, Divider, Stack, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  CHILD_WORK_ITEM_STATUSES,
  type ChildWorkItemContract,
  type ChildWorkItemStatus,
} from "@scarn/api/frontend-contracts";
import { CHILD_WORK_ITEM_STATUS_DISPLAY } from "./child-work-item-status-icon";
import { RelationshipEyebrow } from "./work-item-relationship-list";
import { WorkItemChildRow } from "./work-item-child-row";

export type ChildWorkItemGroup = {
  status: ChildWorkItemStatus;
  children: ChildWorkItemContract[];
};

/** The non-empty status groups, in section order, rows kept in creation order. */
export function groupChildWorkItems(
  children: readonly ChildWorkItemContract[],
): ChildWorkItemGroup[] {
  return CHILD_WORK_ITEM_STATUSES.map((status) => ({
    status,
    children: children.filter((child) => child.status === status),
  })).filter((group) => group.children.length > 0);
}

/** One bar split into a segment per status, sized by its share of the children. */
export function ChildWorkItemsProgress({
  groups,
  total,
  closed,
}: {
  groups: readonly ChildWorkItemGroup[];
  total: number;
  closed: number;
}) {
  return (
    <Box
      role="progressbar"
      aria-label="Child work items closed"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={closed}
      sx={{
        display: "flex",
        height: 6,
        borderRadius: 3,
        overflow: "hidden",
        bgcolor: "action.hover",
      }}
    >
      {groups.map((group) => (
        <Box
          key={group.status}
          data-status={group.status}
          sx={{
            width: `${String((group.children.length / total) * 100)}%`,
            bgcolor: CHILD_WORK_ITEM_STATUS_DISPLAY[group.status].color,
          }}
        />
      ))}
    </Box>
  );
}

function ChildWorkItemGroupSection({
  group,
  canManage,
  pending,
  onRemove,
}: {
  group: ChildWorkItemGroup;
  canManage: boolean;
  pending: boolean;
  onRemove: (child: ChildWorkItemContract) => void;
}) {
  const [expanded, setExpanded] = useState(group.status !== "closed");
  const { label } = CHILD_WORK_ITEM_STATUS_DISPLAY[group.status];

  return (
    <Stack spacing={0.5} data-testid={`child-group-${group.status}`}>
      <ButtonBase
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
        sx={{ alignSelf: "flex-start", gap: 0.5, borderRadius: 1 }}
      >
        <ExpandMoreIcon
          sx={{
            fontSize: 18,
            color: "text.disabled",
            transition: "transform 120ms ease",
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
          }}
        />
        <RelationshipEyebrow>{label}</RelationshipEyebrow>
        <Typography variant="caption" color="text.secondary">
          {group.children.length}
        </Typography>
      </ButtonBase>
      {expanded ? (
        <Stack divider={<Divider />} sx={{ mx: -2 }}>
          {group.children.map((child) => (
            <Box
              key={child.id}
              sx={{
                px: 2,
                py: 1,
                "&:hover": { backgroundColor: "action.hover" },
              }}
            >
              <WorkItemChildRow
                child={child}
                canManage={canManage}
                disabled={pending}
                onRemove={() => {
                  onRemove(child);
                }}
              />
            </Box>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

export function ChildWorkItemGroups({
  groups,
  canManage,
  pending,
  onRemove,
}: {
  groups: readonly ChildWorkItemGroup[];
  canManage: boolean;
  pending: boolean;
  onRemove: (child: ChildWorkItemContract) => void;
}) {
  return (
    <Stack spacing={1.5}>
      {groups.map((group) => (
        <ChildWorkItemGroupSection
          key={group.status}
          group={group}
          canManage={canManage}
          pending={pending}
          onRemove={onRemove}
        />
      ))}
    </Stack>
  );
}
