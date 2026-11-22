export type ProjectInviteStatus = "pending" | "accepted" | "revoked" | "expired";

export const PROJECT_INVITE_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;

export function isProjectInviteStatus(value: string): value is ProjectInviteStatus {
  return PROJECT_INVITE_STATUSES.includes(value as ProjectInviteStatus);
}
