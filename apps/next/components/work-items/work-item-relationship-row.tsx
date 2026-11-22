"use client";

import { useState } from "react";
import {
  Box,
  Divider,
  IconButton,
  Link as MuiLink,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { useProjectPath } from "@/components/project-route-context";
import { PlatformIcon } from "./work-item-platform";

/**
 * The "..." menu on a linked work item: "Copy link" for any viewer, and the
 * remove action only when `canManage`.
 */
export function RelationshipActionsMenu({
  href,
  canManage,
  removeLabel,
  onRemove,
  disabled = false,
  label = "Relationship actions",
}: {
  href: string;
  canManage: boolean;
  removeLabel: string;
  onRemove: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);

  const closeMenu = () => {
    setMenuAnchor(null);
  };

  const handleCopyLink = () => {
    const url =
      typeof window === "undefined" ? href : `${window.location.origin}${href}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    });
    closeMenu();
  };

  return (
    <>
      <Tooltip title={label}>
        <span>
          <IconButton
            size="small"
            onClick={(e) => {
              setMenuAnchor(e.currentTarget);
            }}
            disabled={disabled}
            aria-label={label}
          >
            <MoreHorizIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={closeMenu}
      >
        <MenuItem onClick={handleCopyLink}>
          <ContentCopyIcon fontSize="small" sx={{ mr: 1 }} />
          {copied ? "Copied!" : "Copy link"}
        </MenuItem>
        {canManage
          ? [
              <Divider key="divider" />,
              <MenuItem
                key="remove"
                onClick={() => {
                  closeMenu();
                  onRemove();
                }}
                sx={{ color: "error.main" }}
              >
                {removeLabel}
              </MenuItem>,
            ]
          : null}
      </Menu>
    </>
  );
}

/**
 * One linked-item row in the Properties panel's Relationships: a platform
 * glyph, the linked item's title (as a link to its detail page), and a
 * trailing "..." menu — always present, matching GitHub's own row chrome,
 * rather than appearing only for members.
 */
export function WorkItemRelationshipRow({
  item,
  canManage,
  removeLabel,
  onRemove,
  disabled = false,
}: {
  item: WorkItemContract;
  canManage: boolean;
  removeLabel: string;
  onRemove: () => void;
  /** Disables the actions menu while a mutation from this subsection is in flight. */
  disabled?: boolean;
}) {
  const projectPath = useProjectPath();
  const href = projectPath("work-items", item.id);

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box
        sx={{
          display: "inline-flex",
          flexShrink: 0,
          color: "text.secondary",
          "& svg": { fontSize: 16 },
        }}
      >
        <PlatformIcon platform={item.platform} fontSize="inherit" />
      </Box>
      <MuiLink
        href={href}
        variant="body2"
        underline="hover"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.title}
      </MuiLink>
      <RelationshipActionsMenu
        href={href}
        canManage={canManage}
        removeLabel={removeLabel}
        onRemove={onRemove}
        disabled={disabled}
      />
    </Stack>
  );
}
