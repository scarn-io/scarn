import { colors } from "@scarn/design-tokens";
import type { EdgeTone } from "./studio-graph-visuals";

/**
 * The graph's colors, from `@scarn/design-tokens` — the same palette the web
 * app's run graph uses. Surfaces and text are `--studio-graph-*` CSS
 * variable references falling back to the dark tokens, so the studio can
 * swap them for its light theme (see `index-html-template.ts`) while hosts
 * that never set them (the docs site) get the dark look. Semantic colors
 * stay concrete: React Flow bakes a marker's color into its SVG id, and they
 * read on both backgrounds anyway.
 */
function themed(name: string, fallback: string): string {
  return `var(--studio-graph-${name}, ${fallback})`;
}

export const palette = {
  bg: themed("bg", colors.bg),
  bgElev: themed("bg-elev", colors.bgElev),
  border: themed("border", colors.border),
  text: themed("text", colors.text),
  textMuted: themed("text-muted", colors.textMuted),
  textDim: themed("text-dim", colors.textDim),
  shadow: themed("shadow", "0 1px 2px rgba(1, 4, 9, 0.6)"),
  borderStrong: colors.borderStrong,
  accent: colors.accent,
  success: colors.successFg,
  danger: colors.dangerFg,
  attention: colors.attentionFg,
  done: colors.doneFg,
  info: colors.accentEmphasis,
} as const;

/** `color` at `percent`% opacity; works for CSS variable colors too. */
export function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${String(percent)}%, transparent)`;
}

export const TONE_COLOR: Record<EdgeTone, string> = {
  flow: palette.borderStrong,
  catch: palette.danger,
  loop: palette.done,
};

export const SEVERITY_COLOR: Record<"error" | "warning" | "info", string> = {
  error: palette.danger,
  warning: palette.attention,
  info: palette.info,
};
