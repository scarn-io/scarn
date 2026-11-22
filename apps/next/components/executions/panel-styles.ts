import type { SxProps, Theme } from "@mui/material";

/**
 * Subtle inset panel used to group related metadata/blocks on the execution
 * detail pages. Reads from theme palette tokens instead of inline `color-mix`
 * so the surface stays consistent and themeable.
 */
export const insetPanelSx: SxProps<Theme> = {
  py: 1.5,
  px: 2,
  borderRadius: 1.5,
  border: 1,
  borderColor: "divider",
  backgroundColor: "action.hover",
};

/**
 * Emphasised callout panel for a single message (e.g. "step not run",
 * "accepted by user"). `tone` selects the accent border + tint.
 */
export function calloutPanelSx(
  tone: "neutral" | "info" | "error" = "neutral",
): SxProps<Theme> {
  const borderColor =
    tone === "info" ? "info.main" : tone === "error" ? "error.main" : "divider";
  return {
    p: 2,
    borderRadius: 1.5,
    border: 1,
    borderColor,
    backgroundColor: (theme) =>
      tone === "error"
        ? theme.palette.error.dark + "1f"
        : tone === "info"
          ? theme.palette.info.main + "14"
          : theme.palette.action.hover,
  };
}
