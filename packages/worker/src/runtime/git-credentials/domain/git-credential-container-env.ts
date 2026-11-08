/**
 * Builds the `containerEnv` entries that point git inside the devcontainer at
 * the Scarn credential helper (decision 5).
 *
 * The entries use git's command-scoped config (`GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`), so one `containerEnv` patch
 * reaches lifecycle commands, the agent and code steps alike. In order:
 *
 *   - `credential.helper=<helperPath>` adds the Scarn helper after any helper
 *     the image or the user's gitconfig already sets, so those answer first
 *     and Scarn is the fallback;
 *   - `credential.useHttpPath=true` so the relay sees the repo path;
 *   - `url.scarn-push-disabled://.pushInsteadOf=https://` makes a plain
 *     `git push` fail (a guardrail, not a boundary);
 *   - with `rewriteSshUrls`, SCP-style and `ssh://` URLs on each allowed host
 *     are rewritten to HTTPS so SSH submodules also go through the helper.
 *     Off when the container has its own SSH agent.
 *
 * `GIT_TERMINAL_PROMPT=0` makes a denied request fail instead of prompting.
 */

/** Where the helper dir is bind-mounted (read-only) inside the container. */
export const CONTAINER_GIT_CREDENTIAL_DIR = "/opt/scarn/git-credential";

export const GIT_CREDENTIAL_HELPER_FILENAME = "git-credential-scarn";

export const CONTAINER_GIT_CREDENTIAL_HELPER_PATH = `${CONTAINER_GIT_CREDENTIAL_DIR}/${GIT_CREDENTIAL_HELPER_FILENAME}`;

export const PUSH_DISABLED_URL_SCHEME = "scarn-push-disabled";

export function buildGitCredentialContainerEnv(input: {
  helperPath: string;
  allowedHosts: readonly string[];
  rewriteSshUrls: boolean;
}): Record<string, string> {
  const entries: [string, string][] = [
    ["credential.helper", input.helperPath],
    ["credential.useHttpPath", "true"],
    [`url.${PUSH_DISABLED_URL_SCHEME}://.pushInsteadOf`, "https://"],
  ];
  if (input.rewriteSshUrls) {
    for (const host of input.allowedHosts) {
      entries.push([`url.https://${host}/.insteadOf`, `git@${host}:`]);
      entries.push([`url.https://${host}/.insteadOf`, `ssh://git@${host}/`]);
    }
  }

  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  });
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
}
