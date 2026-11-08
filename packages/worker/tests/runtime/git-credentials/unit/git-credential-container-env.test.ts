/**
 * Unit tests for {@link buildGitCredentialContainerEnv}: the ordered
 * `GIT_CONFIG_*` entries and `GIT_TERMINAL_PROMPT`.
 */
import { describe, expect, test } from "bun:test";
import {
  buildGitCredentialContainerEnv,
  CONTAINER_GIT_CREDENTIAL_DIR,
  CONTAINER_GIT_CREDENTIAL_HELPER_PATH,
} from "../../../../src/runtime/git-credentials/domain/git-credential-container-env";

describe("buildGitCredentialContainerEnv", () => {
  test("adds the helper after existing ones and rewrites SSH URLs", () => {
    expect(CONTAINER_GIT_CREDENTIAL_DIR).toBe("/opt/scarn/git-credential");
    expect(
      buildGitCredentialContainerEnv({
        helperPath: CONTAINER_GIT_CREDENTIAL_HELPER_PATH,
        allowedHosts: ["github.com", "git.example.com:8443"],
        rewriteSshUrls: true,
      }),
    ).toEqual({
      GIT_CONFIG_COUNT: "7",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "/opt/scarn/git-credential/git-credential-scarn",
      GIT_CONFIG_KEY_1: "credential.useHttpPath",
      GIT_CONFIG_VALUE_1: "true",
      GIT_CONFIG_KEY_2: "url.scarn-push-disabled://.pushInsteadOf",
      GIT_CONFIG_VALUE_2: "https://",
      GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_3: "git@github.com:",
      GIT_CONFIG_KEY_4: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_4: "ssh://git@github.com/",
      GIT_CONFIG_KEY_5: "url.https://git.example.com:8443/.insteadOf",
      GIT_CONFIG_VALUE_5: "git@git.example.com:8443:",
      GIT_CONFIG_KEY_6: "url.https://git.example.com:8443/.insteadOf",
      GIT_CONFIG_VALUE_6: "ssh://git@git.example.com:8443/",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  test("leaves SSH URLs alone without rewriteSshUrls", () => {
    const env = buildGitCredentialContainerEnv({
      helperPath: CONTAINER_GIT_CREDENTIAL_HELPER_PATH,
      allowedHosts: ["github.com"],
      rewriteSshUrls: false,
    });
    expect(env["GIT_CONFIG_COUNT"]).toBe("3");
    expect(Object.values(env)).not.toContain("git@github.com:");
  });
});
