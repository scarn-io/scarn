import { isDeepStrictEqual } from "node:util";
import { resolveRepoConfig } from "@scarn/sdk/repo-config";
import type { StepDefContract } from "./step-file-contract";
import { templateToExpr } from "./step-file-template-source";

const REPO_MESSAGE_SCOPES = ["input", "result"] as const;
const REPO_BASE_BRANCH_SCOPES = ["input", "env"] as const;

/**
 * The top-level `repo` property lines for a step, or null when the
 * resolved config is its runtime's default. `Repo.*` takes the function form
 * only when the message or base branch reads `input`, `result` or `env`,
 * destructuring exactly the proxies it uses.
 */
export function buildRepoProperty(step: StepDefContract): string | null {
  const { repo } = step;
  if (isDeepStrictEqual(repo, resolveRepoConfig())) {
    return null;
  }
  const opts: string[] = [];
  const usedScopes = new Set<string>();
  const pushTemplate = (
    name: string,
    template: string,
    scopes: readonly string[],
  ) => {
    const rendered = templateToExpr(template, scopes);
    opts.push(`${name}: ${rendered.expr}`);
    for (const scope of rendered.usedScopes) usedScopes.add(scope);
  };

  if (repo.mode === "readWrite") {
    if (repo.message !== null) {
      pushTemplate("message", repo.message, REPO_MESSAGE_SCOPES);
    }
    if (repo.onPushFailure !== "fail") {
      opts.push(`onPushFailure: ${JSON.stringify(repo.onPushFailure)}`);
    }
  }
  if (repo.gitCredentials !== "auto") {
    opts.push(`gitCredentials: ${JSON.stringify(repo.gitCredentials)}`);
  }
  if (repo.baseBranch !== null) {
    pushTemplate("baseBranch", repo.baseBranch, REPO_BASE_BRANCH_SCOPES);
  }
  if (repo.mode === "readWrite" && repo.workBranch.kind !== "create") {
    opts.push(`workBranch: WorkBranch.${repo.workBranch.kind}()`);
  }

  const call = `Repo.${repo.mode}(${opts.length > 0 ? `{ ${opts.join(", ")} }` : ""})`;
  const params = ["input", "result", "env"].filter((scope) =>
    usedScopes.has(scope),
  );
  return params.length === 0
    ? `  repo: ${call}`
    : `  repo: ({ ${params.join(", ")} }) => ${call}`;
}
