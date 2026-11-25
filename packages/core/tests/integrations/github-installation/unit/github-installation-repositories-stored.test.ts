import { describe, expect } from "bun:test";
import { readStoredGitHubInstallationRepositories } from "@/integrations/github-installation/contracts/github-installation-repositories-stored";
import { concurrentTest } from "tests/utils";
import repositoriesFixtures from "../fixtures/selected-repositories.json";

describe("github_installations.selected_repositories_json stored reader", () => {
  for (const fixture of repositoriesFixtures) {
    concurrentTest(`reads the ${fixture.name} fixture`, () => {
      expect(
        readStoredGitHubInstallationRepositories(
          fixture.selectedRepositoriesJson,
        ),
      ).toEqual({ success: true, value: fixture.expected });
    });
  }

  concurrentTest("reads a scalar as all repositories", () => {
    for (const value of ["repos", 1, true, undefined]) {
      expect(readStoredGitHubInstallationRepositories(value)).toEqual({
        success: true,
        value: null,
      });
    }
  });
});
