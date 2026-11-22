// Pretty-URL helpers for `/{username}/{projectSlug}` project routes.
//
// URLs are always built from live `username` + `projectSlug` data (never a
// cached/persisted string) so a username rename self-heals every internal link.
// The username is the project owner's username (the first URL segment); the
// slug is the project's `slug` from the project contract.

/** Base path for a project: `/{username}/{projectSlug}`. */
export const projectPath = (username: string, projectSlug: string): string =>
  `/${encodeURIComponent(username)}/${encodeURIComponent(projectSlug)}`;

/** A path under a project, e.g. `/{username}/{projectSlug}/work-items`. */
export const projectSubPath = (
  username: string,
  projectSlug: string,
  ...segments: string[]
): string => {
  const suffix = segments
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const base = projectPath(username, projectSlug);
  return suffix ? `${base}/${suffix}` : base;
};
