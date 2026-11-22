import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildRepoCheck, installWizardTestDom } from "./wizard-test-dom";
import type {
  RepoCheckInput,
  SetUpProjectInput,
} from "@scarn/core/projects/project/contracts/project-setup-contracts";
import type { VerifiedCredential } from "@/components/integrations/token-credential-form";

installWizardTestDom();

const pushMock = mock((href: string) => {
  void href;
});
let searchParamsValue = new URLSearchParams();
void mock.module("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => searchParamsValue,
}));

type ApiResult = { data: unknown; error: unknown };

let repoCheckResult: ApiResult = { data: buildRepoCheck(), error: null };
let createResult: ApiResult = {
  data: { slug: "api", initialSyncFailed: false },
  error: null,
};
const repoCheckCalls: RepoCheckInput[] = [];
const createCalls: SetUpProjectInput[] = [];

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: {
        "repo-check": {
          post: (body: RepoCheckInput) => {
            repoCheckCalls.push(body);
            return Promise.resolve(repoCheckResult);
          },
        },
        post: (body: SetUpProjectInput) => {
          createCalls.push(body);
          return Promise.resolve(createResult);
        },
      },
    },
  }),
}));

void mock.module("@/components/integrations/token-credential-form", () => ({
  TokenCredentialForm: (props: {
    onVerified: (verified: VerifiedCredential) => void;
  }) => (
    <button
      onClick={() => {
        props.onVerified({
          credential: { token: "ghp_secret" },
          connection: { method: "unsaved" },
          account: "octocat",
          repo: { id: 7, fullName: "acme/api" },
        });
      }}
    >
      Verify token
    </button>
  ),
}));

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ProjectsNewPageClient } = await import("./projects-new-page-client");

const renderPage = (query: string, githubAppConfigured = true) => {
  searchParamsValue = new URLSearchParams(query);
  return render(
    <ProjectsNewPageClient
      username="connor"
      githubAppConfigured={githubAppConfigured}
    />,
  );
};

const currentStep = (view: ReturnType<typeof render>) =>
  view.container.querySelector('[aria-current="step"]')?.textContent;

describe("ProjectsNewPageClient", () => {
  beforeEach(() => {
    repoCheckResult = { data: buildRepoCheck(), error: null };
    createResult = {
      data: { slug: "api", initialSyncFailed: false },
      error: null,
    };
    repoCheckCalls.length = 0;
    createCalls.length = 0;
    pushMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("with no query it starts on the Repository step", () => {
    const view = renderPage("");

    expect(currentStep(view)).toBe("Repository");
    expect(view.getByLabelText(/Repository URL/)).toBeTruthy();
    expect(repoCheckCalls).toEqual([]);
  });

  test("the CLI hand-off starts on Details with the URL and name filled in", async () => {
    const view = renderPage(
      "gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&name=Acme+API&source=cli",
    );

    const name = (await view.findByLabelText(
      /Project name/,
    )) as HTMLInputElement;
    expect(currentStep(view)).toBe("Details");
    expect(name.value).toBe("Acme API");
    expect(view.getByText("https://github.com/acme/api")).toBeTruthy();
    expect(repoCheckCalls).toEqual([{ gitUrl: "https://github.com/acme/api" }]);

    fireEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(pushMock).toHaveBeenCalledWith(
      "/projects/new?gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&name=Acme+API&source=cli&step=issues",
    );
  });

  test("returning from the GitHub App install lands on Issues, connected", async () => {
    repoCheckResult = {
      data: buildRepoCheck({
        githubApp: { installationId: "42", accountLogin: "acme" },
      }),
      error: null,
    };
    const view = renderPage(
      "gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&name=api&step=issues&installation=connected",
    );

    expect(
      await view.findByText("Connected through GitHub App (acme)."),
    ).toBeTruthy();
    expect(currentStep(view)).toBe("Issues");
    expect(view.getByText("GitHub account connected.")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/connor/api/work-items");
    });
    expect(createCalls).toEqual([
      {
        name: "api",
        description: null,
        gitUrl: "https://github.com/acme/api",
        origin: "web",
        issueTracker: {
          type: "github_app",
          installationId: "42",
          firstSyncHorizonDays: 7,
        },
      },
    ]);
  });

  test("the install link returns to the Issues step without flash params", async () => {
    const view = renderPage(
      "gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&name=api&step=issues&error=expired",
    );

    const install = await view.findByRole("link", {
      name: "Install the GitHub App on acme/api",
    });
    const href = new URL(install.getAttribute("href") ?? "", "http://x");
    expect(href.searchParams.get("returnTo")).toBe(
      "/projects/new?gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&name=api&step=issues",
    );
  });

  test("Skip for now creates a project with no integration", async () => {
    createResult = {
      data: { slug: "api", initialSyncFailed: false },
      error: null,
    };
    const view = renderPage(
      "gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&name=api&description=Our+API&step=issues&source=cli",
    );

    fireEvent.click(await view.findByRole("button", { name: "Skip for now" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/connor/api/work-items");
    });
    expect(createCalls).toEqual([
      {
        name: "api",
        description: "Our API",
        gitUrl: "https://github.com/acme/api",
        origin: "cli_handoff",
      },
    ]);
  });

  test("a failed first sync goes to the work items with syncFailed=1", async () => {
    repoCheckResult = {
      data: buildRepoCheck({
        githubApp: { installationId: "42", accountLogin: "acme" },
      }),
      error: null,
    };
    createResult = {
      data: { slug: "api", initialSyncFailed: true },
      error: null,
    };
    const view = renderPage(
      "gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&name=api&step=issues",
    );

    fireEvent.click(
      await view.findByRole("button", { name: "Create project" }),
    );

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        "/connor/api/work-items?syncFailed=1",
      );
    });
  });

  test("an unsaved token is sent to create and flagged for the one-time banner", async () => {
    const view = renderPage(
      "gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&name=api&step=issues",
    );

    fireEvent.click(await view.findByRole("radio", { name: "GitHub token" }));
    fireEvent.click(view.getByRole("button", { name: "Verify token" }));
    fireEvent.click(view.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        "/connor/api/work-items?connectedWithUnsavedToken=1",
      );
    });
    expect(createCalls).toEqual([
      {
        name: "api",
        description: null,
        gitUrl: "https://github.com/acme/api",
        origin: "web",
        issueTracker: {
          type: "github_token",
          firstSyncHorizonDays: 7,
          credential: { token: "ghp_secret" },
        },
      },
    ]);
    expect(window.location.search).not.toContain("ghp_secret");
  });

  test("Issues without a name falls back to Details", async () => {
    const view = renderPage(
      "gitUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi&step=issues",
    );

    const name = (await view.findByLabelText(
      /Project name/,
    )) as HTMLInputElement;
    expect(name.value).toBe("api");
    expect(currentStep(view)).toBe("Details");
  });
});
