"use client";

/**
 * The conversation sheet's header: close (✕ on desktop, ← on mobile), the
 * agent's name and status, the work item's title, a widen toggle on desktop
 * and the ⋯ menu with the conversation's actions, **Open run** and **Stop**.
 */

import {
  Box,
  Chip,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckIcon from "@mui/icons-material/Check";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import CloseIcon from "@mui/icons-material/Close";
import FlagIcon from "@mui/icons-material/Flag";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import StopIcon from "@mui/icons-material/Stop";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ConversationContract } from "@scarn/api/frontend-contracts";
import { useMenu } from "@/components/common/use-menu";
import {
  useHasProjectPermission,
  useIsProjectMember,
} from "@/components/project-route-context";
import {
  useConversationActions,
  type ConversationActionItem,
} from "./conversation-panel";
import type {
  ConversationActionOutcome,
  ConversationData,
} from "./use-conversation";

const MENU_ITEM_SX = { minHeight: 44 };

const ACTION_ICONS: Record<ConversationActionItem["key"], ReactNode> = {
  "ask-to-finish": <FlagIcon fontSize="small" />,
  done: <CheckIcon fontSize="small" />,
  continue: <SkipNextIcon fontSize="small" />,
};

export function ConversationStatusChip({
  status,
}: {
  status: ConversationContract["status"];
}) {
  switch (status) {
    case "waiting_for_person":
      return <Chip size="small" color="warning" label="Waiting on you" />;
    case "agent_turn":
    case "reply_pending":
      return (
        <Chip size="small" color="info" variant="outlined" label="Thinking" />
      );
    case "closed":
      return <Chip size="small" variant="outlined" label="Ended" />;
  }
}

/**
 * Done, Continue without reply and Ask it to finish (as
 * `useConversationActions` allows), Open run, and Stop for an agent Task
 * (`executions:write`).
 */
function ConversationSheetMenu({
  data,
  runHref,
  onStop,
  onOutcome,
}: {
  data: ConversationData;
  runHref: string | null;
  /** Null when there is no agent Task to stop. */
  onStop: (() => Promise<void>) | null;
  onOutcome: (outcome: ConversationActionOutcome) => void;
}) {
  const menu = useMenu();
  const actions = useConversationActions(data);
  const isMember = useIsProjectMember();
  const canStop =
    useHasProjectPermission("executions:write") && isMember && onStop !== null;
  if (actions.length === 0 && runHref === null && !canStop) return null;

  return (
    <>
      <IconButton
        aria-label="Conversation actions"
        onClick={menu.onOpen}
        sx={{ width: 44, height: 44 }}
      >
        <MoreHorizIcon />
      </IconButton>
      <Menu
        anchorEl={menu.anchorEl}
        open={menu.open}
        onClose={menu.onClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 240 } } }}
      >
        {actions.map((action) => (
          <MenuItem
            key={action.key}
            disabled={action.disabled}
            onClick={() => {
              menu.onClose();
              void action.run().then(onOutcome);
            }}
            sx={MENU_ITEM_SX}
          >
            <ListItemIcon>{ACTION_ICONS[action.key]}</ListItemIcon>
            <ListItemText primary={action.label} />
          </MenuItem>
        ))}
        {runHref !== null ? (
          <MenuItem
            component={Link}
            href={runHref}
            onClick={menu.onClose}
            sx={MENU_ITEM_SX}
          >
            <ListItemIcon>
              <OpenInNewIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Open run" />
          </MenuItem>
        ) : null}
        {canStop ? (
          <MenuItem
            onClick={() => {
              menu.onClose();
              void onStop();
            }}
            sx={{ ...MENU_ITEM_SX, color: "error.main" }}
          >
            <ListItemIcon sx={{ color: "inherit" }}>
              <StopIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Stop" />
          </MenuItem>
        ) : null}
      </Menu>
    </>
  );
}

export function ConversationSheetHeader({
  data,
  agentName,
  workItemTitle,
  mobile,
  wide,
  onToggleWide,
  onClose,
  runHref,
  onStop,
  onOutcome,
}: {
  data: ConversationData;
  agentName: string;
  workItemTitle: string;
  mobile: boolean;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  runHref: string | null;
  onStop: (() => Promise<void>) | null;
  onOutcome: (outcome: ConversationActionOutcome) => void;
}) {
  const status = data.conversation?.status ?? null;
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.5}
      sx={{
        px: 0.5,
        minHeight: 56,
        pt: mobile ? "env(safe-area-inset-top)" : 0,
        borderBottom: 1,
        borderColor: "divider",
        flexShrink: 0,
      }}
    >
      <IconButton
        aria-label={mobile ? "Back" : "Close"}
        onClick={onClose}
        sx={{ width: 44, height: 44 }}
      >
        {mobile ? <ArrowBackIcon /> : <CloseIcon />}
      </IconButton>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography sx={{ fontWeight: 600, fontSize: 15 }} noWrap>
            {agentName}
          </Typography>
          {status !== null ? <ConversationStatusChip status={status} /> : null}
        </Stack>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          component="div"
        >
          {workItemTitle}
        </Typography>
      </Box>
      {mobile ? null : (
        <Tooltip title={wide ? "Narrow" : "Widen"}>
          <IconButton
            aria-label={wide ? "Narrow" : "Widen"}
            onClick={onToggleWide}
            sx={{ width: 44, height: 44 }}
          >
            {wide ? (
              <CloseFullscreenIcon fontSize="small" />
            ) : (
              <OpenInFullIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
      )}
      <ConversationSheetMenu
        data={data}
        runHref={runHref}
        onStop={onStop}
        onOutcome={onOutcome}
      />
    </Stack>
  );
}
