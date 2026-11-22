import type { ReactNode } from "react";
import GitHubIcon from "@mui/icons-material/GitHub";
import ViewKanbanOutlinedIcon from "@mui/icons-material/ViewKanbanOutlined";
import TimelineOutlinedIcon from "@mui/icons-material/TimelineOutlined";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import SourceOutlinedIcon from "@mui/icons-material/SourceOutlined";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";

type Platform = WorkItemContract["platform"];

const PLATFORM_LABELS: Record<Platform, string> = {
  jira: "Jira",
  github: "GitHub",
  bitbucket: "Bitbucket",
  linear: "Linear",
  scarn: "Scarn",
  custom: "Custom",
};

/** Human-friendly label for a work item platform. */
export function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS[platform];
}

/** Small platform glyph, sized to sit inline with text or in an avatar. */
export function PlatformIcon({
  platform,
  fontSize = "small",
}: {
  platform: Platform;
  fontSize?: "inherit" | "small" | "medium" | "large";
}): ReactNode {
  switch (platform) {
    case "github":
      return <GitHubIcon fontSize={fontSize} />;
    case "bitbucket":
      return <SourceOutlinedIcon fontSize={fontSize} />;
    case "jira":
      return <ViewKanbanOutlinedIcon fontSize={fontSize} />;
    case "linear":
      return <TimelineOutlinedIcon fontSize={fontSize} />;
    case "scarn":
      return <HubOutlinedIcon fontSize={fontSize} />;
    default:
      return <ArticleOutlinedIcon fontSize={fontSize} />;
  }
}
