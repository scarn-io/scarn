import { usernameSchema } from "../contracts/auth-contracts";

export interface UsernameSuggestionSource {
  githubLogin?: string | null;
  name?: string | null;
  email?: string | null;
}

const MAX_USERNAME_LENGTH = 32;

/**
 * Coerces free-form text toward the username rules: lowercase alphanumerics
 * separated by single hyphens, at most 32 characters. Returns null when nothing
 * usable remains or the result still fails `usernameSchema` (too short,
 * reserved).
 */
export function normalizeUsernameCandidate(raw: string): string | null {
  const slug = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_USERNAME_LENGTH)
    .replace(/-+$/g, "");

  const parsed = usernameSchema.safeParse(slug);
  return parsed.success ? parsed.data : null;
}

/**
 * Ordered username candidates for onboarding: the GitHub login, then a slug of
 * the display name, then the email's local part. Invalid candidates are
 * dropped and duplicates collapsed; availability is the caller's concern.
 */
export function usernameSuggestionCandidates(
  source: UsernameSuggestionSource,
): string[] {
  const raws = [
    source.githubLogin,
    source.name,
    source.email ? source.email.split("@")[0] : null,
  ];
  const candidates: string[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    const candidate = normalizeUsernameCandidate(raw);
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}
