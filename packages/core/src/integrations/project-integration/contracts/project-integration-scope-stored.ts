import { z } from "zod";
import { createStoredReader } from "@scarn/core/lib/db/stored-json";

/**
 * Read-side schemas for `project_integrations.external_scope_json`, one per
 * `schema_version`. The scope's shape depends on the row's `kind` column, so
 * the reader takes both and returns them as one discriminated value.
 *
 * Structural only: the write-side rules in `project-integration-contracts.ts`
 * (trimmed non-empty strings, at least one repo or project key, `baseUrl` as
 * a URL, integer repo ids, no unknown keys) are not re-applied, so
 * tightening them never makes a stored integration unreadable. Unknown keys
 * are stripped. Each version's shape is frozen here.
 *
 * A breaking change to the stored shape adds a new version, a stored schema
 * for it, a `vN → vN+1` converter and a fixture under
 * `tests/integrations/project-integration/fixtures/`. See
 * `docs/persistence/json-columns.md`.
 */

const storedGitHubScopeV1Schema = z.object({
  repos: z.array(z.object({ id: z.number(), fullName: z.string() })),
});

const storedBitbucketScopeV1Schema = z.object({
  repos: z.array(
    z.object({
      workspace: z.string(),
      slug: z.string(),
      fullName: z.string(),
    }),
  ),
});

const storedJiraScopeV1Schema = z.object({
  baseUrl: z.string(),
  projectKeys: z.array(z.string()),
});

const storedProjectIntegrationScopeV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github_app"),
    scope: storedGitHubScopeV1Schema,
  }),
  z.object({
    kind: z.literal("github_token"),
    scope: storedGitHubScopeV1Schema,
  }),
  z.object({
    kind: z.literal("bitbucket"),
    scope: storedBitbucketScopeV1Schema,
  }),
  z.object({
    kind: z.literal("jira"),
    scope: storedJiraScopeV1Schema,
  }),
]);

export type StoredProjectIntegrationScope = z.infer<
  typeof storedProjectIntegrationScopeV1Schema
>;

export const CURRENT_PROJECT_INTEGRATION_SCHEMA_VERSION = 1;

/** The columns of a `project_integrations` row the scope is read from. */
export type StoredProjectIntegrationColumns = {
  kind: string;
  externalScopeJson: unknown;
};

/**
 * Reads a row's `external_scope_json` at `schemaVersion` into the current
 * scope shape for its `kind`, or explains why it is unreadable.
 */
export const readStoredProjectIntegrationScope = createStoredReader<
  StoredProjectIntegrationColumns,
  StoredProjectIntegrationScope,
  1
>({
  current: CURRENT_PROJECT_INTEGRATION_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedProjectIntegrationScopeV1Schema.safeParse({
        kind: columns.kind,
        scope: columns.externalScopeJson,
      }),
  },
});
