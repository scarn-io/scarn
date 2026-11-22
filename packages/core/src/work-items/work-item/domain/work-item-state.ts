export const WORK_ITEM_STATES = ["open", "closed"] as const;

export type WorkItemState = (typeof WORK_ITEM_STATES)[number];
