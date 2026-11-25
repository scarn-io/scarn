import { z } from "zod";
import { createTolerantReader } from "@scarn/core/lib/db/stored-json";
import type { GitHubInstallationRepository } from "../domain/github-installation-entity";

/**
 * Read-side schema for `github_installations.selected_repositories_json`.
 * Tolerant, not versioned: it mirrors the repositories GitHub reports for
 * the installation and is resynced from GitHub.
 *
 * The column is null (all repositories) or an array of `{ id, fullName }`.
 * Entries with a numeric `id` and a string `fullName` are kept, others are
 * skipped, and other keys are dropped. Anything other than an array reads
 * as null. So every value reads.
 *
 * Structural only and frozen here. See `docs/persistence/json-columns.md`.
 */
const storedRepositoryEntrySchema = z.object({
  id: z.number(),
  fullName: z.string(),
});

const storedSelectedRepositoriesSchema = z
  .unknown()
  .transform((value): GitHubInstallationRepository[] | null =>
    Array.isArray(value)
      ? value.flatMap((entry) => {
          const parsed = storedRepositoryEntrySchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : null,
  );

/** Reads an installation's `selected_repositories_json`. */
export const readStoredGitHubInstallationRepositories = createTolerantReader<
  GitHubInstallationRepository[] | null
>(storedSelectedRepositoriesSchema);
