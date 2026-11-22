import type { Page } from "@playwright/test";

/**
 * Identifies a project by its pretty-URL location: `/{username}/{projectSlug}`.
 * The app no longer routes projects by UUID (`/projects/:projectId`); the first
 * two path segments are the owner username and the project slug.
 */
export interface ProjectRouteLocation {
  readonly username: string;
  readonly projectSlug: string;
}

const PROJECT_ROUTE_PATTERN = /^\/([^/]+)\/([^/]+)(?:\/|$)/;

/**
 * First path segments that are reserved top-level routes, not project owner
 * usernames. A `/{username}/{projectSlug}` matcher must exclude these so it does
 * not match e.g. `/invite/{token}` (which would otherwise look like a two-
 * segment project route).
 */
const RESERVED_FIRST_SEGMENTS = new Set([
  "invite",
  "login",
  "dashboard",
  "organizations",
  "api",
]);

/**
 * True when `pathname` looks like a project route `/{username}/{projectSlug}`
 * whose first segment is an owner username (not a reserved top-level route).
 */
export function isProjectRoutePathname(pathname: string): boolean {
  const match = PROJECT_ROUTE_PATTERN.exec(pathname);
  const firstSegment = match?.[1];
  if (!firstSegment) {
    return false;
  }
  return !RESERVED_FIRST_SEGMENTS.has(firstSegment);
}

/**
 * Extracts the `{username, projectSlug}` from the current page URL. Throws with
 * the observed URL when the path does not look like a project route.
 */
export function parseProjectRoute(page: Page): ProjectRouteLocation {
  const { pathname } = new URL(page.url());
  const match = PROJECT_ROUTE_PATTERN.exec(pathname);
  const username = match?.[1];
  const projectSlug = match?.[2];

  if (!username || !projectSlug) {
    throw new Error(
      `Expected a /{username}/{projectSlug} project URL, but got: ${page.url()}`,
    );
  }

  return { username, projectSlug };
}

/** Builds the base path for a project route. */
export function projectRoutePath(location: ProjectRouteLocation): string {
  return `/${location.username}/${location.projectSlug}`;
}
