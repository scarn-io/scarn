"use client";

import type { ReactNode } from "react";
import { Box, Chip, Radio, Stack, Typography } from "@mui/material";
import type { IssueTrackerOption } from "./issue-tracker-choice";

export const OPTION_COPY: Record<
  IssueTrackerOption,
  { title: string; description: string }
> = {
  github_app: {
    title: "GitHub App",
    description: "Scarn keeps issues in sync automatically.",
  },
  github_token: {
    title: "GitHub token",
    description: "Use your own personal access token for this repository.",
  },
  bitbucket: {
    title: "Bitbucket token",
    description:
      "Pull this repository's Bitbucket issues with your Atlassian API token.",
  },
  jira: {
    title: "Jira",
    description:
      "Pull issues from Jira projects with your Atlassian API token.",
  },
};

/** One selectable issue-tracking option; its body shows while it's selected. */
export function IssueTrackerOptionCard({
  option,
  selected,
  recommended,
  onSelect,
  children,
}: {
  option: IssueTrackerOption;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const copy = OPTION_COPY[option];
  return (
    <Box
      sx={{
        border: 1,
        borderColor: selected ? "primary.main" : "divider",
        borderRadius: 2,
        px: 2,
        py: 1.5,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="flex-start"
        onClick={onSelect}
        sx={{ cursor: "pointer" }}
      >
        <Radio
          size="small"
          checked={selected}
          onChange={onSelect}
          value={option}
          slotProps={{ input: { "aria-label": copy.title } }}
          sx={{ p: 0.5 }}
        />
        <Stack spacing={0.25} sx={{ pt: 0.25 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2">{copy.title}</Typography>
            {recommended ? (
              <Chip size="small" color="primary" label="Recommended" />
            ) : null}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {copy.description}
          </Typography>
        </Stack>
      </Stack>
      {selected ? <Box sx={{ pt: 2, pl: 4.5 }}>{children}</Box> : null}
    </Box>
  );
}
