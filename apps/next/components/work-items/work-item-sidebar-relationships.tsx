"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { parseUuidV7, parseWorkItemId } from "@scarn/api/frontend-contracts";
import type { WorkItemBlockContract } from "@scarn/core/work-items/work-item-block/contracts/work-item-block-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { useIsProjectMember } from "@/components/project-route-context";
import { useWorkItemParent } from "./use-work-item-parent";
import { useWorkItemBlocks } from "./use-work-item-blocks";
import {
  WorkItemRelationshipPickerDialog,
  type RelationshipPickerMode,
} from "./work-item-relationship-picker-dialog";
import {
  RelationshipEyebrow,
  useResolvedWorkItems,
} from "./work-item-relationship-list";
import { WorkItemRelationshipRow } from "./work-item-relationship-row";

/**
 * Sidebar "Relationships" section: Parent work item, Blocked by, and
 * Blocking — mirroring GitHub's issue sidebar. Child work items live in the
 * main content instead (`WorkItemChildrenSection`), matching GitHub's own split.
 *
 * Quiet-until-clicked, matching GitHub: the "Relationships" eyebrow is
 * itself the only add affordance for a member. Clicking it opens a dropdown
 * with "Set parent work item" / "Mark as blocked by" / "Mark as blocking",
 * each opening the shared picker dialog. A non-member or an item with
 * nothing set just sees a quiet "None yet." line.
 */
export function WorkItemSidebarRelationships({
  projectId,
  workItem,
  onWorkItemChanged,
}: {
  projectId: string;
  workItem: WorkItemContract;
  onWorkItemChanged: (updated: WorkItemContract) => void;
}) {
  const isMember = useIsProjectMember();

  const parentId = workItem.parentWorkItemId;
  const {
    item: parentItem,
    loading: parentLoading,
    error: parentError,
  } = useWorkItemParent(parentId);

  const {
    blockedBy,
    blocking,
    loading: blocksLoading,
    error: blocksError,
    setBlockedBy,
    setBlocking,
  } = useWorkItemBlocks(workItem.id);

  const blockedByOtherIds = useMemo(
    () => blockedBy.map((block) => block.blockingWorkItemId),
    [blockedBy],
  );
  const blockingOtherIds = useMemo(
    () => blocking.map((block) => block.blockedWorkItemId),
    [blocking],
  );
  const blockedByItems = useResolvedWorkItems(blockedByOtherIds);
  const blockingItems = useResolvedWorkItems(blockingOtherIds);

  const [actionError, setActionError] = useState<string | null>(null);
  const [isActionPending, startAction] = useTransition();

  const handleRemoveParent = () => {
    setActionError(null);
    startAction(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api["work-items"]({
        workItemId: parseWorkItemId(workItem.id),
      }).parent.patch({ parentWorkItemId: null });
      if (err) {
        setActionError(
          parseApiError(err, "Could not remove parent. Try again."),
        );
        return;
      }
      onWorkItemChanged(data);
    });
  };

  const handleRemoveBlock = (
    block: WorkItemBlockContract,
    direction: "blockedBy" | "blocking",
  ) => {
    setActionError(null);
    startAction(async () => {
      const client = getBrowserScarnApiClient();
      const { error: err } = await client.api["work-item-blocks"]({
        blockId: parseUuidV7(block.id),
      }).delete(undefined);
      if (err) {
        setActionError(parseApiError(err, "Could not remove link. Try again."));
        return;
      }
      if (direction === "blockedBy") {
        setBlockedBy((prev) => prev.filter((b) => b.id !== block.id));
      } else {
        setBlocking((prev) => prev.filter((b) => b.id !== block.id));
      }
    });
  };

  // ─── "Relationships" header dropdown ──────────────────────────────────
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [picker, setPicker] = useState<{
    mode: RelationshipPickerMode;
    excludeIds: Set<string>;
  } | null>(null);

  const openMenu = (event: React.MouseEvent<HTMLElement>) => {
    if (!isMember) return;
    setMenuAnchor(event.currentTarget);
  };
  const closeMenu = () => {
    setMenuAnchor(null);
  };

  const openParentPicker = () => {
    closeMenu();
    // The backend rejects cycles outright (`WORK_ITEM_PARENT_CYCLE`); the
    // sidebar doesn't have this item's children loaded (that list lives in
    // `WorkItemChildrenSection`), so it only excludes the item itself.
    setPicker({
      mode: { kind: "parent" },
      excludeIds: new Set([workItem.id]),
    });
  };

  const openBlockPicker = (direction: "blockedBy" | "blocking") => {
    closeMenu();
    setPicker({
      mode: { kind: "block", initialDirection: direction },
      excludeIds: new Set([
        workItem.id,
        ...blockedByOtherIds,
        ...blockingOtherIds,
      ]),
    });
  };

  const handleLinked = (result: WorkItemContract | WorkItemBlockContract) => {
    if (!picker) return;
    if (picker.mode.kind === "parent") {
      onWorkItemChanged(result as WorkItemContract);
      return;
    }
    const block = result as WorkItemBlockContract;
    if (block.blockedWorkItemId === workItem.id) {
      setBlockedBy((prev) => [...prev, block]);
    } else {
      setBlocking((prev) => [...prev, block]);
    }
  };

  const hasAnyRelationship =
    Boolean(parentId) || blockedBy.length > 0 || blocking.length > 0;
  const stillLoading = (Boolean(parentId) && parentLoading) || blocksLoading;

  return (
    <Stack spacing={1.25}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.5}
        onClick={openMenu}
        sx={{
          alignSelf: "flex-start",
          cursor: isMember ? "pointer" : "default",
        }}
      >
        <RelationshipEyebrow>Relationships</RelationshipEyebrow>
        {isMember ? (
          <ExpandMoreIcon sx={{ fontSize: 16, color: "text.disabled" }} />
        ) : null}
      </Stack>

      {isMember ? (
        <Menu
          anchorEl={menuAnchor}
          open={Boolean(menuAnchor)}
          onClose={closeMenu}
        >
          <MenuItem onClick={openParentPicker}>
            {parentId ? "Change parent work item" : "Set parent work item"}
          </MenuItem>
          <MenuItem
            onClick={() => {
              openBlockPicker("blockedBy");
            }}
          >
            Mark as blocked by
          </MenuItem>
          <MenuItem
            onClick={() => {
              openBlockPicker("blocking");
            }}
          >
            Mark as blocking
          </MenuItem>
        </Menu>
      ) : null}

      {actionError ? <Alert severity="error">{actionError}</Alert> : null}
      {parentError ? <Alert severity="error">{parentError}</Alert> : null}
      {blocksError ? <Alert severity="error">{blocksError}</Alert> : null}

      {stillLoading && !hasAnyRelationship ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
          <CircularProgress size={16} />
        </Box>
      ) : !hasAnyRelationship ? (
        <Typography variant="body2" color="text.secondary">
          None yet.
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {parentId ? (
            <Stack spacing={0.5}>
              <Typography variant="caption" color="text.secondary">
                Parent
              </Typography>
              {parentLoading ? (
                <CircularProgress size={14} />
              ) : parentItem ? (
                <WorkItemRelationshipRow
                  item={parentItem}
                  canManage={isMember}
                  removeLabel="Remove parent"
                  onRemove={handleRemoveParent}
                  disabled={isActionPending}
                />
              ) : null}
            </Stack>
          ) : null}

          {blockedBy.length > 0 ? (
            <Stack spacing={0.5}>
              <Typography variant="caption" color="text.secondary">
                Blocked by
              </Typography>
              <Stack spacing={1}>
                {blockedBy.map((block) => {
                  const item = blockedByItems[block.blockingWorkItemId];
                  return item ? (
                    <WorkItemRelationshipRow
                      key={block.id}
                      item={item}
                      canManage={isMember}
                      removeLabel="Remove"
                      onRemove={() => {
                        handleRemoveBlock(block, "blockedBy");
                      }}
                      disabled={isActionPending}
                    />
                  ) : (
                    <CircularProgress key={block.id} size={14} />
                  );
                })}
              </Stack>
            </Stack>
          ) : null}

          {blocking.length > 0 ? (
            <Stack spacing={0.5}>
              <Typography variant="caption" color="text.secondary">
                Blocking
              </Typography>
              <Stack spacing={1}>
                {blocking.map((block) => {
                  const item = blockingItems[block.blockedWorkItemId];
                  return item ? (
                    <WorkItemRelationshipRow
                      key={block.id}
                      item={item}
                      canManage={isMember}
                      removeLabel="Remove"
                      onRemove={() => {
                        handleRemoveBlock(block, "blocking");
                      }}
                      disabled={isActionPending}
                    />
                  ) : (
                    <CircularProgress key={block.id} size={14} />
                  );
                })}
              </Stack>
            </Stack>
          ) : null}
        </Stack>
      )}

      {picker ? (
        <WorkItemRelationshipPickerDialog
          open
          onClose={() => {
            setPicker(null);
          }}
          projectId={projectId}
          workItem={workItem}
          mode={picker.mode}
          excludeIds={picker.excludeIds}
          onLinked={handleLinked}
        />
      ) : null}
    </Stack>
  );
}
