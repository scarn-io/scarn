import type { Components, Theme } from "@mui/material";
import { colors } from "@scarn/design-tokens";
import { controlComponents } from "./theme-components-controls";

const PRIMER_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
const PRIMER_TRANSITION = `80ms ${PRIMER_EASE}`;

export const components: Components<Omit<Theme, "components">> = {
  ...controlComponents,
  MuiAppBar: {
    styleOverrides: {
      root: {
        backgroundImage: "none",
        backgroundColor: colors.bgHeader,
        backdropFilter: "none",
        WebkitBackdropFilter: "none",
        boxShadow: "none",
      },
    },
  },
  MuiDrawer: {
    styleOverrides: {
      paper: {
        backgroundImage: "none",
        backgroundColor: colors.bgElev,
        borderRight: `1px solid ${colors.border}`,
      },
    },
  },
  MuiCard: {
    styleOverrides: {
      root: {
        backgroundImage: "none",
        backgroundColor: colors.bgElev,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        boxShadow:
          "0 1px 0 rgba(1, 4, 9, 0.6), 0 1px 3px rgba(1, 4, 9, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.02)",
      },
    },
  },
  MuiPaper: {
    styleOverrides: {
      root: {
        backgroundImage: "none",
        backgroundColor: colors.bgElev,
      },
      outlined: {
        borderColor: colors.border,
      },
    },
  },
  MuiTableCell: {
    styleOverrides: {
      root: {
        borderColor: colors.border,
        fontSize: "0.8125rem",
      },
      head: {
        color: colors.textMuted,
        fontWeight: 600,
        fontSize: "0.75rem",
        backgroundColor: colors.bgElev,
      },
    },
  },
  MuiChip: {
    styleOverrides: {
      root: {
        borderRadius: 999,
        fontWeight: 600,
        fontSize: "0.75rem",
        height: 20,
        paddingInline: 2,
      },
      // Neutral counters/labels (GitHub-style) instead of solid gray pills.
      filled: {
        "&.MuiChip-colorDefault": {
          backgroundColor: "rgba(110, 118, 129, 0.25)",
          color: colors.text,
        },
      },
      sizeSmall: {
        height: 20,
      },
      outlined: {
        borderColor: colors.border,
      },
    },
  },
  MuiTabs: {
    styleOverrides: {
      indicator: {
        height: 2,
        backgroundColor: colors.accentFg,
        borderRadius: 2,
      },
    },
  },
  MuiTab: {
    styleOverrides: {
      root: {
        fontSize: "0.875rem",
        fontWeight: 500,
        color: colors.text,
        minHeight: 44,
        padding: "8px 12px",
        borderRadius: 6,
        textTransform: "none",
        transition: PRIMER_TRANSITION,
        "& .MuiSvgIcon-root": {
          fontSize: 16,
          color: colors.textMuted,
        },
        "&:hover": {
          color: colors.text,
          backgroundColor: colors.bgHover,
        },
        "&.Mui-selected": {
          color: colors.text,
          fontWeight: 600,
          "& .MuiSvgIcon-root": {
            color: colors.text,
          },
        },
      },
    },
  },
  MuiListItemButton: {
    styleOverrides: {
      root: {
        borderRadius: 6,
        marginInline: 8,
        paddingBlock: 6,
        transition: PRIMER_TRANSITION,
        "&:hover": {
          backgroundColor: colors.bgHover,
        },
        "&.Mui-selected": {
          backgroundColor: colors.bgHover,
          "&:hover": { backgroundColor: colors.bgHover },
          "& .MuiListItemText-primary": { fontWeight: 600 },
          // Selected-nav marker: a small accent rail on the left edge.
          "&::before": {
            content: '""',
            position: "absolute",
            left: -8,
            top: "50%",
            transform: "translateY(-50%)",
            width: 3,
            height: 20,
            borderRadius: 3,
            backgroundColor: colors.accentFg,
          },
        },
      },
    },
  },
  MuiDivider: {
    styleOverrides: {
      root: {
        borderColor: colors.border,
      },
    },
  },
  MuiAlert: {
    styleOverrides: {
      root: {
        borderRadius: 6,
        fontSize: "0.875rem",
        border: "1px solid",
      },
      standardError: {
        backgroundColor: colors.dangerSubtle,
        borderColor: colors.dangerMuted,
        color: colors.text,
        "& .MuiAlert-icon": { color: colors.dangerFg },
      },
      standardWarning: {
        backgroundColor: colors.attentionSubtle,
        borderColor: colors.attentionMuted,
        color: colors.text,
        "& .MuiAlert-icon": { color: colors.attentionFg },
      },
      standardSuccess: {
        backgroundColor: colors.successSubtle,
        borderColor: colors.successMuted,
        color: colors.text,
        "& .MuiAlert-icon": { color: colors.successFg },
      },
      standardInfo: {
        backgroundColor: colors.accentSubtle,
        borderColor: colors.accentMuted,
        color: colors.text,
        "& .MuiAlert-icon": { color: colors.accentFg },
      },
    },
  },
  MuiTooltip: {
    styleOverrides: {
      tooltip: {
        backgroundColor: "#1c2128",
        border: `1px solid ${colors.border}`,
        color: colors.text,
        fontSize: "0.75rem",
        padding: "4px 8px",
        borderRadius: 6,
      },
    },
  },
  MuiLink: {
    styleOverrides: {
      root: {
        color: colors.accentFg,
        textDecorationColor: "transparent",
        transition: PRIMER_TRANSITION,
        "&:hover": {
          textDecorationColor: colors.accentFg,
        },
      },
    },
  },
  MuiMenu: {
    styleOverrides: {
      paper: {
        backgroundImage: "none",
        backgroundColor: colors.bgElev,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        boxShadow:
          "0 8px 24px rgba(1, 4, 9, 0.6), 0 0 0 1px rgba(1, 4, 9, 0.4)",
        marginTop: 4,
      },
      list: {
        paddingBlock: 4,
      },
    },
  },
  // Popover shares no base styling with Menu by default, but every filter/sort
  // control in this app builds its dropdown on Popover — without this, those
  // panels render as a bare, unbordered MuiPaper instead of the bordered,
  // shadowed surface every other floating panel gets.
  MuiPopover: {
    styleOverrides: {
      paper: {
        backgroundImage: "none",
        backgroundColor: colors.bgElev,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        boxShadow:
          "0 8px 24px rgba(1, 4, 9, 0.6), 0 0 0 1px rgba(1, 4, 9, 0.4)",
        marginTop: 4,
      },
    },
  },
  MuiMenuItem: {
    styleOverrides: {
      root: {
        fontSize: "0.875rem",
        borderRadius: 6,
        marginInline: 4,
        paddingBlock: 6,
        transition: PRIMER_TRANSITION,
        "&:hover": {
          backgroundColor: colors.borderMuted,
        },
        "&.Mui-selected": {
          backgroundColor: colors.accentSubtle,
          color: colors.accentFg,
          "&:hover": { backgroundColor: colors.accentSubtle },
        },
      },
    },
  },
};
