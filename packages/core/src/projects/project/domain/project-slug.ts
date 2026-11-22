import { z } from "zod";
import { CoreValidationError } from "@scarn/core/lib/errors";

export type ProjectSlug = string & { readonly __brand: "project-slug" };

// Lowercase alphanumerics with single interior hyphens, 1-64 chars. This mirrors
// the shape used for URL path segments elsewhere in the app and is what
// `slugify` always produces.
const projectSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SLUG_LENGTH = 64;

export const isProjectSlug = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_SLUG_LENGTH &&
  projectSlugPattern.test(value);

/**
 * Deterministically derive a URL-safe slug from a project name. Lowercases,
 * strips accents, replaces any run of non-alphanumeric characters with a single
 * hyphen, and trims leading/trailing hyphens. Falls back to "project" when the
 * name has no slug-able characters (e.g. a name made entirely of symbols), so
 * the result always satisfies `isProjectSlug`.
 */
export const slugify = (name: string): ProjectSlug => {
  const normalized = name
    .normalize("NFKD")
    // Drop combining marks left behind by NFKD (accents, diacritics).
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/gu, "");

  return (normalized || "project") as ProjectSlug;
};

/**
 * Given a desired base slug and the set of slugs already taken within the same
 * org, return a unique slug. On collision it appends `-2`, `-3`, … (matching the
 * project-name de-dup convention) until a free slug is found.
 */
export const deduplicateProjectSlug = (
  baseSlug: string,
  takenSlugs: ReadonlySet<string>,
): ProjectSlug => {
  const parsedBase = parseProjectSlug(baseSlug);
  if (!takenSlugs.has(parsedBase)) {
    return parsedBase;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = truncateWithSuffix(parsedBase, suffix);
    if (!takenSlugs.has(candidate)) {
      return candidate;
    }
  }
};

// Keep the `-N` suffix intact when the base is long enough to overflow the max
// length: trim the base, not the disambiguating suffix.
const truncateWithSuffix = (base: string, suffix: number): ProjectSlug => {
  const suffixText = `-${String(suffix)}`;
  const maxBaseLength = MAX_SLUG_LENGTH - suffixText.length;
  const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/gu, "");
  return `${trimmedBase}${suffixText}` as ProjectSlug;
};

export const parseProjectSlug = (value: string): ProjectSlug => {
  const normalized = value.trim();

  if (!isProjectSlug(normalized)) {
    throw new CoreValidationError(
      `Project slug must be lowercase letters, numbers, or single interior hyphens: ${value}`,
      "INVALID_PROJECT_SLUG",
    );
  }

  return normalized as ProjectSlug;
};

export const projectSlugSchema = z
  .string()
  .trim()
  .refine((value) => isProjectSlug(value), {
    message:
      "slug must be lowercase letters, numbers, or single interior hyphens",
  });
