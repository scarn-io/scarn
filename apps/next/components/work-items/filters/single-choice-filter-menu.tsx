"use client";

import CheckIcon from "@mui/icons-material/Check";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Button,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Popover,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import { useMenu } from "@/components/common/use-menu";

const PANE_WIDTH = 288;
const LIST_MAX_HEIGHT = 360;

export type SingleChoiceOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

export type SingleChoiceGroup<T extends string> = {
  heading?: string;
  options: SingleChoiceOption<T>[];
};

/**
 * A strip control over a single-valued clause: the popover lists every value,
 * choosing one replaces the clause, and re-choosing the active value clears
 * it — the same "re-select to remove" rule as the other menus in the strip.
 * An optional "all" row clears the clause explicitly, for controls whose
 * default (no clause) deserves its own name.
 */
export function SingleChoiceFilterMenu<T extends string>({
  label,
  title,
  description,
  allLabel,
  groups,
  active,
  onChange,
}: {
  label: string;
  title: string;
  description: string;
  allLabel?: string;
  groups: SingleChoiceGroup<T>[];
  active: T | undefined;
  onChange: (value: T | undefined) => void;
}) {
  const menu = useMenu();

  const choose = (value: T | undefined) => {
    onChange(value === active ? undefined : value);
    menu.onClose();
  };

  const hasIcons = groups.some((group) =>
    group.options.some((option) => option.icon !== undefined),
  );

  return (
    <>
      <Button
        size="small"
        color="inherit"
        endIcon={<ExpandMoreIcon />}
        onClick={menu.onOpen}
        sx={{ flexShrink: 0, whiteSpace: "nowrap" }}
      >
        {label}
      </Button>
      <Popover
        open={menu.open}
        anchorEl={menu.anchorEl}
        onClose={menu.onClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        <Box sx={{ width: PANE_WIDTH }}>
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            <Typography variant="subtitle2">{title}</Typography>
            <Typography variant="caption" color="text.secondary">
              {description}
            </Typography>
          </Box>
          <Divider />
          <List
            dense
            sx={{ py: 0, maxHeight: LIST_MAX_HEIGHT, overflowY: "auto" }}
          >
            {allLabel !== undefined && (
              <ListItemButton
                selected={active === undefined}
                onClick={() => {
                  choose(undefined);
                }}
              >
                <ListItemText primary={allLabel} />
                {active === undefined && (
                  <CheckIcon fontSize="small" color="primary" />
                )}
              </ListItemButton>
            )}
            {groups.flatMap((group, index) => [
              ...(group.heading === undefined
                ? []
                : [
                    <ListSubheader
                      key={`heading-${String(index)}`}
                      sx={{ lineHeight: "32px" }}
                    >
                      {group.heading}
                    </ListSubheader>,
                  ]),
              ...group.options.map((option) => (
                <ListItemButton
                  key={option.value}
                  selected={option.value === active}
                  onClick={() => {
                    choose(option.value);
                  }}
                >
                  {hasIcons && (
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      {option.icon}
                    </ListItemIcon>
                  )}
                  <ListItemText primary={option.label} />
                  {option.value === active && (
                    <CheckIcon fontSize="small" color="primary" />
                  )}
                </ListItemButton>
              )),
            ])}
          </List>
        </Box>
      </Popover>
    </>
  );
}
