"use client";

import { CssBaseline, GlobalStyles, ThemeProvider } from "@mui/material";
import { colors } from "@scarn/design-tokens";
import { FONT_MONO, theme } from "./theme";

export { CONTENT_MAX_WIDTH, NAVBAR_BG } from "./theme";

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <GlobalStyles
        styles={{
          body: {
            color: colors.text,
            fontSize: 14,
          },
          a: {
            color: "inherit",
            textDecoration: "none",
          },
          pre: {
            margin: 0,
            fontFamily: FONT_MONO,
          },
          code: {
            fontFamily: FONT_MONO,
          },
        }}
      />
      {children}
    </ThemeProvider>
  );
}
