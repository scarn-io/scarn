"use client";

import { useState } from "react";
import {
  Box,
  Chip,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Link as MuiLink,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import Link from "next/link";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { useProjectPath } from "@/components/project-route-context";
import { PlatformIcon, platformLabel } from "./work-item-platform";
import { useWorkItemParent } from "./use-work-item-parent";
import { WorkItemStateButton } from "./work-item-state-control";
import {
  WorkItemStatusRing,
  type WorkItemRingStatus,
} from "./work-item-status-ring";

/**
 * The work item page's header: a breadcrumb (Work Items › parent › title),
 * then the viewer's status ring, the key and the platform chip over the
 * title. Close/Reopen stays visible; the notifications and pipeline runs
 * drawers sit behind the `⋯` menu.
 */
export function WorkItemDetailHeader({
  workItem,
  ringStatus,
  showNotifications = true,
  notificationCount,
  executionCount,
  onOpenNotifications,
  onOpenExecutions,
  onStateChanged,
}: {
  workItem: WorkItemContract;
  ringStatus: WorkItemRingStatus;
  /** Notifications are per-user and member-only (issue #150). */
  showNotifications?: boolean;
  notificationCount: number | undefined;
  executionCount: number | undefined;
  onOpenNotifications: () => void;
  onOpenExecutions: () => void;
  /** Present when the viewer may close or reopen the item. */
  onStateChanged?:
    ((updated: WorkItemContract, postedComment: boolean) => void) | undefined;
}) {
  const projectPath = useProjectPath();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = () => {
    setMenuAnchor(null);
  };

  return (
    <Stack spacing={1.5}>
      <Breadcrumb
        workItem={workItem}
        workItemsHref={projectPath("work-items")}
      />

      <Stack
        direction="row"
        spacing={2}
        alignItems="flex-start"
        justifyContent="space-between"
      >
        <Stack spacing={1} sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <WorkItemStatusRing status={ringStatus} />
            <Typography
              component="span"
              variant="body2"
              color="text.secondary"
              sx={{ fontFamily: "var(--font-mono)" }}
            >
              {workItem.platformKey}
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              icon={
                <PlatformIcon platform={workItem.platform} fontSize="inherit" />
              }
              label={platformLabel(workItem.platform)}
            />
          </Stack>
          <Typography
            variant="h1"
            sx={{
              fontSize: { xs: "1.6rem", sm: "1.95rem" },
              fontWeight: 700,
              lineHeight: 1.2,
              letterSpacing: "-0.02em",
            }}
          >
            {workItem.title}
          </Typography>
        </Stack>

        <Stack
          direction="row"
          spacing={0.5}
          alignItems="center"
          sx={{ flexShrink: 0, pt: 0.5 }}
        >
          {onStateChanged ? (
            <WorkItemStateButton
              workItem={workItem}
              onChanged={onStateChanged}
            />
          ) : null}
          <Tooltip title="More">
            <IconButton
              aria-label="More actions"
              onClick={(event) => {
                setMenuAnchor(event.currentTarget);
              }}
            >
              <MoreHorizIcon />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={menuAnchor}
            open={Boolean(menuAnchor)}
            onClose={closeMenu}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            {showNotifications ? (
              <MenuItem
                onClick={() => {
                  closeMenu();
                  onOpenNotifications();
                }}
              >
                <ListItemIcon>
                  <NotificationsNoneIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>
                  Notifications{countSuffix(notificationCount)}
                </ListItemText>
              </MenuItem>
            ) : null}
            <MenuItem
              onClick={() => {
                closeMenu();
                onOpenExecutions();
              }}
            >
              <ListItemIcon>
                <PlayCircleOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>
                Pipeline runs{countSuffix(executionCount)}
              </ListItemText>
            </MenuItem>
          </Menu>
        </Stack>
      </Stack>
    </Stack>
  );
}

const countSuffix = (count: number | undefined) =>
  typeof count === "number" ? ` (${String(count)})` : "";

function Breadcrumb({
  workItem,
  workItemsHref,
}: {
  workItem: WorkItemContract;
  workItemsHref: string;
}) {
  const projectPath = useProjectPath();
  const { item: parent } = useWorkItemParent(workItem.parentWorkItemId);
  const separator = (
    <Box component="span" aria-hidden sx={{ mx: 1, color: "text.disabled" }}>
      ›
    </Box>
  );

  return (
    <Typography
      component="nav"
      aria-label="Breadcrumb"
      variant="body2"
      color="text.secondary"
      sx={{
        display: "flex",
        alignItems: "center",
        minWidth: 0,
        whiteSpace: "nowrap",
      }}
    >
      <MuiLink
        component={Link}
        href={workItemsHref}
        underline="hover"
        color="inherit"
      >
        Work Items
      </MuiLink>
      {parent ? (
        <>
          {separator}
          <MuiLink
            component={Link}
            href={projectPath("work-items", parent.id)}
            underline="hover"
            color="inherit"
            sx={{ overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {parent.title}
          </MuiLink>
        </>
      ) : null}
      {separator}
      <Box
        component="span"
        aria-current="page"
        sx={{
          color: "text.primary",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {workItem.title}
      </Box>
    </Typography>
  );
}
