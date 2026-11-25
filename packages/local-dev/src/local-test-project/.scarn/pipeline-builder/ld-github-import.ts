/**
 * GitHub import: the `ld-github-import` project automation's `import` rule
 * runs `import-github`, a `githubIssueImport` library step, every 5 minutes.
 * It reads `scarn-io/scarn`'s issues through GitHub's remote MCP server and
 * upserts each as a `github` work item keyed `scarn-io/scarn#<number>`. The
 * first run reaches back 30 days; later runs read from the newest imported
 * update. The `default` automation skips items labelled `github`, so imports
 * don't start pipelines.
 *
 * The token is the `GITHUB_TOKEN` project secret, which seed saves only when
 * `SCARN_LOCAL_DEV_GITHUB_TOKEN` is set. Without it the run fails at startup
 * with `SCARN_ENVIRONMENT_UNRESOLVED`, so seed leaves this automation
 * disabled; start it with **Run now** or `automations run`.
 */
import { defineAutomation } from "@scarn/sdk/automations";
import { Env } from "@scarn/sdk/definitions/steps";
import { githubIssueImport } from "@scarn/sdk/library/github";

export const importGitHub = githubIssueImport({
  key: "import-github",
  repos: ["scarn-io/scarn"],
  auth: { type: "apiKey", token: Env.secret("GITHUB_TOKEN") },
});

export default defineAutomation({
  key: "ld-github-import",
  title: "Local dev: import GitHub issues every 5 minutes",
  scope: "project",
  rules: [githubIssueImport.schedule(importGitHub)],
});
