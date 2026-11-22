import type { Components, Theme } from "@mui/material";
import { colors } from "@scarn/design-tokens";

const PRIMER_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
const PRIMER_TRANSITION = `80ms ${PRIMER_EASE}`;

/** Form-control and button overrides, merged into the theme's `components`. */
export const controlComponents: Components<Omit<Theme, "components">> = {
  MuiButton: {
    defaultProps: {
      variant: "contained",
      disableElevation: true,
    },
    styleOverrides: {
      root: {
        borderRadius: 6,
        fontWeight: 500,
        fontSize: "0.875rem",
        lineHeight: 1.45,
        padding: "5px 16px",
        minHeight: 32,
        whiteSpace: "nowrap",
        boxShadow: "none",
        transition: PRIMER_TRANSITION,
        "&:focus-visible": {
          outline: `2px solid ${colors.accentFg}`,
          outlineOffset: 2,
        },
      },
      sizeSmall: {
        minHeight: 28,
        padding: "3px 12px",
        fontSize: "0.8125rem",
      },
      sizeLarge: {
        minHeight: 40,
        padding: "8px 20px",
        fontSize: "0.875rem",
      },
      contained: {
        backgroundColor: "#21262d",
        color: colors.text,
        border: "1px solid rgba(240, 246, 252, 0.1)",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.03)",
        "&:hover": {
          backgroundColor: "#30363d",
          borderColor: "#8b949e",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.03)",
        },
        "&:active": {
          backgroundColor: "#282e33",
        },
        "&.Mui-disabled": {
          backgroundColor: "#21262d",
          color: colors.textDim,
          border: "1px solid rgba(240, 246, 252, 0.1)",
        },
      },
      containedPrimary: {
        backgroundColor: colors.accentEmphasis,
        color: "#06121a",
        fontWeight: 600,
        border: "1px solid transparent",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.18)",
        "&:hover": {
          backgroundColor: colors.accentHover,
          borderColor: "transparent",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.18)",
        },
        "&:active": {
          backgroundColor: colors.accentActive,
        },
        "&.Mui-disabled": {
          backgroundColor: colors.accentEmphasis,
          color: "#06121a",
          opacity: 0.45,
        },
      },
      containedSecondary: {
        backgroundColor: colors.doneEmphasis,
        color: "#ffffff",
        border: "1px solid rgba(240, 246, 252, 0.1)",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
        "&:hover": {
          backgroundColor: colors.doneFg,
        },
      },
      containedError: {
        backgroundColor: colors.dangerEmphasis,
        color: "#ffffff",
        border: "1px solid rgba(240, 246, 252, 0.1)",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
        "&:hover": {
          backgroundColor: colors.dangerFg,
        },
      },
      outlined: {
        backgroundColor: "transparent",
        color: colors.text,
        borderColor: colors.border,
        "&:hover": {
          backgroundColor: "#30363d",
          borderColor: colors.borderStrong,
        },
      },
      text: {
        color: colors.accentFg,
        "&:hover": {
          backgroundColor: "rgba(56, 189, 248, 0.1)",
        },
      },
    },
  },
  MuiOutlinedInput: {
    styleOverrides: {
      root: {
        borderRadius: 6,
        backgroundColor: colors.bg,
        fontSize: "0.875rem",
        transition: PRIMER_TRANSITION,
        "& .MuiOutlinedInput-notchedOutline": {
          borderColor: colors.border,
        },
        "&:hover .MuiOutlinedInput-notchedOutline": {
          borderColor: colors.borderStrong,
        },
        "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
          borderColor: colors.accentFg,
          borderWidth: 1,
          boxShadow: `0 0 0 3px ${colors.accentSubtle}`,
        },
      },
    },
  },
  MuiTextField: {
    defaultProps: {
      size: "small",
    },
  },
  MuiFormControl: {
    defaultProps: {
      size: "small",
    },
  },
  MuiFormControlLabel: {
    styleOverrides: {
      // The compact switch below has no ripple padding, so the default -11px
      // control offset would butt the label against the track.
      root: {
        marginLeft: 0,
        gap: 8,
      },
      label: {
        fontSize: "0.875rem",
      },
    },
  },
  MuiSwitch: {
    styleOverrides: {
      root: {
        width: 38,
        height: 22,
        padding: 0,
      },
      switchBase: {
        padding: 3,
        "&.Mui-checked": {
          transform: "translateX(16px)",
          color: "#fff",
          "& + .MuiSwitch-track": {
            backgroundColor: colors.accentEmphasis,
            opacity: 1,
          },
        },
      },
      thumb: {
        width: 16,
        height: 16,
        boxShadow: "0 1px 2px rgba(1, 4, 9, 0.6)",
      },
      track: {
        borderRadius: 999,
        backgroundColor: colors.border,
        opacity: 1,
      },
    },
  },
  MuiToggleButton: {
    styleOverrides: {
      root: {
        textTransform: "none",
        fontSize: "0.8125rem",
        fontWeight: 500,
        color: colors.textMuted,
        borderColor: colors.border,
        "&.Mui-selected": {
          backgroundColor: colors.accentSubtle,
          color: colors.accentFg,
          "&:hover": { backgroundColor: colors.accentSubtle },
        },
      },
    },
  },
};
