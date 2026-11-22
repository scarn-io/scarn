export const WORK_ITEM_PLATFORMS = [
  "jira",
  "github",
  "bitbucket",
  "linear",
  "scarn",
  "custom",
] as const;

export type WorkItemPlatform = (typeof WORK_ITEM_PLATFORMS)[number];
