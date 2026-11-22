import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildRepoCheck, installWizardTestDom } from "./wizard-test-dom";

installWizardTestDom();

type ApiResult = { data: unknown; error: unknown };

let repoCheckResult: ApiResult = { data: buildRepoCheck(), error: null };
const repoCheckCalls: { gitUrl: string }[] = [];

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: {
        "repo-check": {
          post: (body: { gitUrl: string }) => {
            repoCheckCalls.push(body);
            return Promise.resolve(repoCheckResult);
          },
        },
      },
    },
  }),
}));

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { RepoUrlStep } = await import("./repo-url-step");

const typeUrl = (view: ReturnType<typeof render>, value: string) => {
  fireEvent.change(view.getByLabelText(/Repository URL/), {
    target: { value },
  });
};

describe("RepoUrlStep", () => {
  beforeEach(() => {
    repoCheckResult = { data: buildRepoCheck(), error: null };
    repoCheckCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("names the host as the user types", () => {
    const view = render(<RepoUrlStep initialGitUrl="" onContinue={() => {}} />);

    typeUrl(view, "https://github.com/acme/api");
    expect(view.getByText("GitHub · acme/api")).toBeTruthy();

    typeUrl(view, "git@bitbucket.org:team/api.git");
    expect(view.getByText("Bitbucket · team/api")).toBeTruthy();

    typeUrl(view, "https://gitlab.example.com/acme/api.git");
    expect(view.getByText("Other git host")).toBeTruthy();
  });

  test("Continue checks the repo and moves on", async () => {
    const onContinue = mock(() => {});
    const view = render(
      <RepoUrlStep initialGitUrl="" onContinue={onContinue} />,
    );

    typeUrl(view, "  https://github.com/acme/api  ");
    fireEvent.click(view.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(onContinue).toHaveBeenCalledWith(
        "https://github.com/acme/api",
        buildRepoCheck(),
      );
    });
    expect(repoCheckCalls).toEqual([{ gitUrl: "https://github.com/acme/api" }]);
  });

  test("an existing project is linked and still lets the user create another", async () => {
    repoCheckResult = {
      data: buildRepoCheck({
        alreadyExists: true,
        existingProject: { name: "API", slug: "api", ownerUsername: "connor" },
      }),
      error: null,
    };
    const onContinue = mock(() => {});
    const view = render(
      <RepoUrlStep
        initialGitUrl="https://github.com/acme/api"
        onContinue={onContinue}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Continue" }));

    const link = await view.findByRole("link", { name: "API" });
    expect(link.getAttribute("href")).toBe("/connor/api");
    expect(onContinue).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Continue anyway" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(repoCheckCalls).toHaveLength(1);
  });

  test("a failed check shows the error", async () => {
    repoCheckResult = {
      data: null,
      error: {
        value: {
          status: 422,
          detail: "gitUrl must be a valid git repository URL",
        },
      },
    };
    const view = render(
      <RepoUrlStep initialGitUrl="not a url" onContinue={() => {}} />,
    );

    fireEvent.click(view.getByRole("button", { name: "Continue" }));

    expect(
      await view.findByText("gitUrl must be a valid git repository URL"),
    ).toBeTruthy();
  });
});
