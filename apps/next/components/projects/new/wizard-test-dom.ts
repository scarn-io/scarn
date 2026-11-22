import { installDom } from "@/tests/support/install-dom";

/**
 * Installs JSDOM globals for the `/projects/new` wizard tests. Call it before
 * dynamically importing React DOM and Testing Library: React DOM decides at
 * import time whether the DOM can emit `input` events, and without that
 * `fireEvent.change` never reaches a controlled field's `onChange`.
 */
export function installWizardTestDom(url = "http://localhost/projects/new") {
  installDom({ url });
  Object.assign(globalThis, {
    requestAnimationFrame: (cb: FrameRequestCallback) =>
      setTimeout(() => {
        cb(Date.now());
      }, 0) as unknown as number,
    cancelAnimationFrame: (id: number) => {
      clearTimeout(id);
    },
  });
}

/** A `POST /projects/repo-check` response for a GitHub repo. */
export const buildRepoCheck = (
  overrides: Partial<{
    host: "github" | "bitbucket" | "other";
    alreadyExists: boolean;
    existingProject: {
      name: string;
      slug: string;
      ownerUsername: string | null;
    } | null;
    githubApp: { installationId: string; accountLogin: string | null } | null;
  }> = {},
) => ({
  host: "github" as const,
  webUrl: "https://github.com/acme/api",
  defaultName: "api",
  alreadyExists: false,
  existingProject: null,
  githubApp: null,
  ...overrides,
});
