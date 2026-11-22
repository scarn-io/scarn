/**
 * "Agent is working" shimmer: a soft light band that sweeps across text on a
 * loop (ChatGPT's "Thinking" treatment). The text keeps its resting color as
 * the base so the state hue stays readable; the band brightens toward
 * `text.primary`. Callers mark animated elements with `data-shimmer="on"` and
 * skip the animation entirely when the user prefers reduced motion; the
 * stylesheet also honors the media query so the first (pre-hydration) render
 * never animates for those users.
 */
import { useMediaQuery } from "@mui/material";
import { keyframes, type Palette, type Theme } from "@mui/material/styles";

const SWEEP_MS = 1800;

const sweep = keyframes`
  from { background-position: 100% 0; }
  to { background-position: 0% 0; }
`;

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Text-clipped shimmer over text whose resting color is `pickBase(palette)`. */
export function shimmerTextSx(pickBase: (palette: Palette) => string) {
  return (theme: Theme) => {
    const base = pickBase(theme.palette);
    const highlight = theme.palette.text.primary;
    return {
      color: "transparent",
      backgroundImage: `linear-gradient(90deg, ${base} 0%, ${base} 40%, ${highlight} 50%, ${base} 60%, ${base} 100%)`,
      backgroundSize: "300% 100%",
      backgroundRepeat: "no-repeat",
      backgroundClip: "text",
      WebkitBackgroundClip: "text",
      animation: `${sweep} ${String(SWEEP_MS)}ms linear infinite`,
      "@media (prefers-reduced-motion: reduce)": {
        animation: "none",
        backgroundImage: "none",
        color: base,
      },
    };
  };
}
