import type {
  GitCredentialDenialReason,
  GitCredentialPolicy,
} from "../domain/git-credential-policy";
import {
  GitCredentialProtocolError,
  parseGitCredentialQuery,
  serializeGitCredential,
  serializeQuit,
  type GitCredentialQuery,
} from "../domain/git-credential-protocol";
import type {
  GitCredentialSource,
  GitCredentialSourceMode,
} from "./git-credential-source";

/**
 * Answers git credential-helper requests for one Task run: parse, policy,
 * source, mask, audit.
 *
 * - `get` is checked against the policy. A denial, a source with no
 *   credential, or a source error all answer `quit=1`, so git stops asking
 *   other helpers and fails normally. A source error's message never reaches
 *   the container.
 * - An issued password is passed to `onSecretValues` before it is returned,
 *   so the run's log masking knows it before anything can echo it.
 * - `store` is ignored without a trace. `erase` is audited as a diagnostic and
 *   ignored. Any other operation is a {@link GitCredentialProtocolError}.
 *
 * Audit entries carry only the request's `protocol`, `host` and `path`, never
 * a username, password or token.
 */

export type GitCredentialOperation = "get" | "store" | "erase";

export type GitCredentialAuditOutcome =
  "issued" | "denied" | "none" | "error" | "ignored";

export type GitCredentialAuditEntry = {
  operation: GitCredentialOperation;
  protocol: string | null;
  host: string | null;
  path: string | null;
  source: GitCredentialSourceMode;
  outcome: GitCredentialAuditOutcome;
  reason: GitCredentialDenialReason | null;
};

export type CredentialRelayOutcome =
  | { status: "issued"; body: string }
  | { status: "denied"; body: string; reason: string }
  | { status: "none"; body: string }
  | { status: "ignored" };

export type CredentialRelayDeps = {
  policy: GitCredentialPolicy;
  source: GitCredentialSource;
  audit: (entry: GitCredentialAuditEntry) => void;
  onSecretValues: (values: readonly string[]) => void;
};

export class CredentialRelay {
  private readonly deps: CredentialRelayDeps;

  constructor(deps: CredentialRelayDeps) {
    this.deps = deps;
  }

  async handleGit(
    operation: string,
    body: string,
  ): Promise<CredentialRelayOutcome> {
    switch (operation) {
      case "get":
        return this.get(parseGitCredentialQuery(body));
      case "store":
        return { status: "ignored" };
      case "erase":
        this.audit("erase", parseQueryLeniently(body), "ignored");
        return { status: "ignored" };
      default:
        throw new GitCredentialProtocolError(
          "Unknown git credential operation.",
        );
    }
  }

  private async get(
    query: GitCredentialQuery,
  ): Promise<CredentialRelayOutcome> {
    const decision = this.deps.policy.evaluate(query);
    if (!decision.allowed) {
      this.audit("get", query, "denied", decision.reason);
      return {
        status: "denied",
        body: serializeQuit(),
        reason: decision.reason,
      };
    }
    let credential;
    try {
      credential = await this.deps.source.get(query);
    } catch {
      this.audit("get", query, "error");
      return { status: "none", body: serializeQuit() };
    }
    if (credential === null) {
      this.audit("get", query, "none");
      return { status: "none", body: serializeQuit() };
    }
    this.deps.onSecretValues([credential.password]);
    const answer = serializeGitCredential(credential);
    this.audit("get", query, "issued");
    return { status: "issued", body: answer };
  }

  private audit(
    operation: GitCredentialOperation,
    query: GitCredentialQuery | null,
    outcome: GitCredentialAuditOutcome,
    reason: GitCredentialDenialReason | null = null,
  ): void {
    this.deps.audit({
      operation,
      protocol: query?.protocol ?? null,
      host: query?.host ?? null,
      path: query?.path ?? null,
      source: this.deps.source.mode,
      outcome,
      reason,
    });
  }
}

function parseQueryLeniently(body: string): GitCredentialQuery | null {
  try {
    return parseGitCredentialQuery(body);
  } catch {
    return null;
  }
}
