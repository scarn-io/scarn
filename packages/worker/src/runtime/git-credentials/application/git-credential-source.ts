import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  GitCredential,
  GitCredentialQuery,
} from "../domain/git-credential-protocol";

/**
 * The seam between the relay and wherever a git credential comes from.
 *
 * - `host`: the worker host's own git credentials (`git credential fill`).
 * - `api`: a short-lived token the Scarn API mints for this Task run.
 *   Phase 6.
 */
export type GitCredentialSourceMode = "host" | "api";

/** What a source may use to scope what it returns. */
export type GitCredentialRunContext = {
  taskRunId: UuidV7;
  claimToken: string;
  repoGitUrl: string;
};

/**
 * Returns a credential for an already policy-approved query, or `null` when it
 * has none. A thrown error must not carry credential material.
 */
export type GitCredentialSource = {
  readonly mode: GitCredentialSourceMode;
  get(query: GitCredentialQuery): Promise<GitCredential | null>;
};

/** Built per Task run so a source can carry the run's claim token. */
export type GitCredentialSourceFactory = (
  context: GitCredentialRunContext,
) => GitCredentialSource;
