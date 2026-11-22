export type ProjectInviteRestriction =
  | "specific_email"
  | "any_authenticated_user";

export const PROJECT_INVITE_RESTRICTIONS = [
  "specific_email",
  "any_authenticated_user",
] as const;

export function isProjectInviteRestriction(
  value: string,
): value is ProjectInviteRestriction {
  return PROJECT_INVITE_RESTRICTIONS.includes(
    value as ProjectInviteRestriction,
  );
}
