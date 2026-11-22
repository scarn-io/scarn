/**
 * Avatar initials for a user. Derived from the `username` first (the user-facing
 * identity), then a display `name`. The email is NOT a source — email-local-part
 * initials leaked PII into the avatar. Returns "?" when neither is available.
 */
export function getUserInitials(
  username: string | null | undefined,
  name: string | null | undefined,
): string {
  const buildInitials = (parts: string[]): string => {
    const first = parts[0] ?? "";
    if (parts.length === 1) {
      return first.slice(0, 2).toUpperCase();
    }
    const last = parts.at(-1) ?? "";
    return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
  };

  const trimmedUsername = username?.trim();
  if (trimmedUsername) {
    // Usernames use hyphens/underscores as word separators (e.g. "quiet-fox").
    const parts = trimmedUsername
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length > 0) return buildInitials(parts);
  }

  const trimmedName = name?.trim();
  if (trimmedName) {
    const parts = trimmedName.split(/\s+/).filter(Boolean);
    return buildInitials(parts);
  }

  return "?";
}
