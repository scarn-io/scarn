import { Box, Typography } from "@mui/material";
import type { RunsNav } from "./runs-params";
import { runsTabOf } from "./runs-scope";

/** The copy for an empty Runs list: what matched nothing, and what to try. */
export function runsEmptyCopy(nav: RunsNav): { title: string; hint: string } {
  if (nav.q !== undefined) {
    return {
      title: `No runs match “${nav.q}”.`,
      hint: "Search looks at titles, work item keys, pipelines, status lines and node ids.",
    };
  }
  if (runsTabOf(nav.status) === "needs-you") {
    return {
      title: "Nothing here is waiting on you.",
      hint: "Switch to All to see every run.",
    };
  }
  return {
    title: "No runs in this view.",
    hint: "Switch to All to see every run.",
  };
}

export function RunsEmpty({ nav }: { nav: RunsNav }) {
  const { title, hint } = runsEmptyCopy(nav);
  return (
    <Box
      data-testid="runs-empty"
      sx={{ py: 6, textAlign: "center", color: "text.secondary" }}
    >
      <Typography>{title}</Typography>
      <Typography variant="body2" sx={{ color: "text.disabled" }}>
        {hint}
      </Typography>
    </Box>
  );
}
