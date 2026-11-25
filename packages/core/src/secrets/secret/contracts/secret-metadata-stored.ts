import { z } from "zod";
import { createStoredReader } from "@scarn/core/lib/db/stored-json";

/**
 * Read-side schemas for `secrets.metadata_json`, one per `schema_version`.
 * The metadata's shape depends on the row's `kind` column, so the reader
 * takes both and returns them as one discriminated value.
 *
 * Structural only: the write-side rules (a valid, lowercased email; a
 * trimmed, non-empty GitHub login) are not re-applied, so tightening them
 * never makes a stored secret unreadable. Unknown keys are stripped. A
 * project secret carries no metadata, so its `metadata_json` is ignored.
 * Each version's shape is frozen here.
 *
 * A breaking change to the stored shape adds a new version, a stored schema
 * for it, a `vN → vN+1` converter and a fixture under
 * `tests/secrets/secret/fixtures/`. See `docs/persistence/json-columns.md`.
 */

const storedEmailMetadataV1Schema = z.object({ email: z.string() });

const storedGitHubTokenMetadataV1Schema = z.object({
  login: z.string().nullable(),
});

const storedSecretMetadataV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("jira_api_key"),
    metadata: storedEmailMetadataV1Schema,
  }),
  z.object({
    kind: z.literal("github_token"),
    metadata: storedGitHubTokenMetadataV1Schema,
  }),
  z.object({
    kind: z.literal("bitbucket_api_token"),
    metadata: storedEmailMetadataV1Schema,
  }),
  z.object({ kind: z.literal("project_secret") }),
]);

export type StoredSecretMetadata = z.infer<typeof storedSecretMetadataV1Schema>;

export const CURRENT_SECRET_SCHEMA_VERSION = 1;

/** The columns of a `secrets` row the metadata is read from. */
export type StoredSecretMetadataColumns = {
  kind: string;
  metadataJson: unknown;
};

/**
 * Reads a row's `metadata_json` at `schemaVersion` into the current metadata
 * shape for its `kind`, or explains why it is unreadable.
 */
export const readStoredSecretMetadata = createStoredReader<
  StoredSecretMetadataColumns,
  StoredSecretMetadata,
  1
>({
  current: CURRENT_SECRET_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedSecretMetadataV1Schema.safeParse({
        kind: columns.kind,
        metadata: columns.metadataJson,
      }),
  },
});
