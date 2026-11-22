import { toDateInputValue } from "./api-key-form-shared";

/** The longest expiry GitHub allows for a fine-grained personal access token. */
export const GITHUB_TOKEN_MAX_EXPIRY_DAYS = 366;

/**
 * A link to GitHub's "new fine-grained token" form, pre-filled with Scarn's
 * name, the longest expiry, and Issues read & write (GitHub adds Metadata
 * read). `owner` sets the resource owner; the user still picks the repository.
 */
export const githubTokenUrl = ({ owner }: { owner?: string } = {}): string => {
  const params = new URLSearchParams({
    name: "Scarn",
    description: "Scarn issue sync",
    ...(owner ? { target_name: owner } : {}),
    expires_in: String(GITHUB_TOKEN_MAX_EXPIRY_DAYS),
    issues: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
};

/** The expiry date GitHub shows for a token made with `githubTokenUrl`. */
export const githubTokenExpiryDate = (today: Date = new Date()): string => {
  const expiry = new Date(today);
  expiry.setDate(expiry.getDate() + GITHUB_TOKEN_MAX_EXPIRY_DAYS);
  return toDateInputValue(expiry);
};
