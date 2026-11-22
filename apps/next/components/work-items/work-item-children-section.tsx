"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Link as MuiLink,
  Stack,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import type {
  ChildWorkItemContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { useIsProjectMember } from "@/components/project-route-context";
import type { WorkItemChildrenData } from "./use-work-item-children";
import { WorkItemRelationshipPickerDialog } from "./work-item-relationship-picker-dialog";
import { RelationshipEyebrow } from "./work-item-relationship-list";
import {
  ChildWorkItemGroups,
  ChildWorkItemsProgress,
  groupChildWorkItems,
} from "./work-item-children-groups";

/**
 * The work item page's child work items, under the description: "N of M
 * closed" with a bar coloured by status, then the children grouped Needs a
 * person, Running, Ready, Blocked, Closed. Empty groups are hidden and
 * Closed starts collapsed. A member adds a child through the relationship
 * picker and removes one by unlinking it (clearing its parent), which never
 * deletes the child. With no children a member sees only the "Add child
 * work item" link, and anyone else sees nothing.
 */
export function WorkItemChildrenSection({
  projectId,
  workItem,
  childrenData,
}: {
  projectId: string;
  workItem: WorkItemContract;
  /** From `useWorkItemChildren`, which the page shares with the description. */
  childrenData: WorkItemChildrenData;
}) {
  const isMember = useIsProjectMember();
  const { children, loading, error, refresh, setChildren } = childrenData;
  const groups = useMemo(() => groupChildWorkItems(children), [children]);
  const closedCount = children.filter((c) => c.status === "closed").length;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActionPending, startAction] = useTransition();

  const excludeIds = useMemo(
    () => new Set([workItem.id, ...children.map((c) => c.id)]),
    [workItem.id, children],
  );

  const handleRemove = (child: ChildWorkItemContract) => {
    setActionError(null);
    startAction(async () => {
      const client = getBrowserScarnApiClient();
      const { error: err } = await client.api["work-items"]({
        workItemId: parseWorkItemId(child.id),
      }).parent.patch({ parentWorkItemId: null });
      if (err) {
        setActionError(
          parseApiError(err, "Could not remove child work item. Try again."),
        );
        return;
      }
      setChildren((prev) => prev.filter((c) => c.id !== child.id));
    });
  };

  const openPicker = () => {
    setPickerOpen(true);
  };

  const pickerDialog = pickerOpen ? (
    <WorkItemRelationshipPickerDialog
      open
      onClose={() => {
        setPickerOpen(false);
      }}
      projectId={projectId}
      workItem={workItem}
      mode={{ kind: "child" }}
      excludeIds={excludeIds}
      onLinked={refresh}
    />
  ) : null;

  if (!error && children.length === 0) {
    if (loading || !isMember) return null;
    return (
      <>
        <MuiLink
          component="button"
          type="button"
          variant="body2"
          underline="hover"
          onClick={openPicker}
          sx={{ alignSelf: "flex-start", color: "text.secondary" }}
        >
          Add child work item
        </MuiLink>
        {pickerDialog}
      </>
    );
  }

  return (
    <Box
      component="section"
      aria-label="Child work items"
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        backgroundColor: "background.paper",
        p: 2,
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <RelationshipEyebrow>Child work items</RelationshipEyebrow>
          {children.length > 0 ? (
            <Typography variant="caption" color="text.secondary">
              {closedCount} of {children.length} closed
            </Typography>
          ) : null}
          <Box sx={{ flexGrow: 1 }} />
          {loading ? <CircularProgress size={14} /> : null}
          {isMember ? (
            <Button
              size="small"
              color="inherit"
              startIcon={<AddIcon fontSize="small" />}
              onClick={openPicker}
              sx={{ textTransform: "none", color: "text.secondary" }}
            >
              Add
            </Button>
          ) : null}
        </Stack>

        {children.length > 0 ? (
          <ChildWorkItemsProgress
            groups={groups}
            total={children.length}
            closed={closedCount}
          />
        ) : null}

        {error ? <Alert severity="error">{error}</Alert> : null}
        {actionError ? <Alert severity="error">{actionError}</Alert> : null}

        <ChildWorkItemGroups
          groups={groups}
          canManage={isMember}
          pending={isActionPending}
          onRemove={handleRemove}
        />
      </Stack>
      {pickerDialog}
    </Box>
  );
}
