import { createTheme } from "@mui/material";
import { colors } from "@scarn/design-tokens";
import { components } from "./theme-components";

export const CONTENT_MAX_WIDTH = 1216;
export const NAVBAR_BG = colors.bgHeader;

const FONT_SANS = "var(--font-sans)";
export const FONT_MONO = "var(--font-mono)";

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: colors.accent,
      light: colors.accentSoft,
      dark: colors.accentEmphasis,
      contrastText: "#06121a",
    },
    secondary: {
      main: colors.accent2,
    },
    background: {
      default: colors.bg,
      paper: colors.bgElev,
    },
    success: {
      main: colors.successFg,
      dark: colors.successEmphasis,
    },
    warning: {
      main: colors.attentionFg,
      dark: colors.attentionEmphasis,
    },
    error: {
      main: colors.dangerFg,
      dark: colors.dangerEmphasis,
    },
    info: {
      main: colors.accent,
    },
    divider: colors.border,
    text: {
      primary: colors.text,
      secondary: colors.textMuted,
      disabled: colors.textDim,
    },
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily: FONT_SANS,
    fontSize: 14,
    htmlFontSize: 16,
    h1: { fontSize: "2rem", fontWeight: 600, lineHeight: 1.25, letterSpacing: "-0.02em" },
    h2: { fontSize: "1.5rem", fontWeight: 600, lineHeight: 1.25, letterSpacing: "-0.01em" },
    h3: { fontSize: "1.25rem", fontWeight: 600, lineHeight: 1.25 },
    h4: { fontSize: "1rem", fontWeight: 600, lineHeight: 1.25 },
    h5: { fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.4 },
    h6: { fontSize: "1rem", fontWeight: 600, lineHeight: 1.25 },
    subtitle1: { fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.4 },
    subtitle2: { fontSize: "0.8125rem", fontWeight: 600, lineHeight: 1.4 },
    body1: { fontSize: "0.875rem", lineHeight: 1.5 },
    body2: { fontSize: "0.8125rem", lineHeight: 1.5 },
    caption: { fontSize: "0.75rem", lineHeight: 1.4 },
    button: {
      textTransform: "none",
      fontWeight: 500,
      fontSize: "0.875rem",
    },
    overline: {
      fontSize: "0.75rem",
      fontWeight: 600,
      letterSpacing: "0.06em",
    },
  },
  components,
});
