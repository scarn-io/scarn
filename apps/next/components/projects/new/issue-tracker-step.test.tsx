import { afterEach, describe, expect, mock, test } from "bun:test";
import { useState, type ReactNode } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { buildRepoCheck, installWizardTestDom } from "./wizard-test-dom";
import type {
  CredentialCheckFailure,
  VerifiedCredential,
} from "@/components/integrations/token-credential-form";

installWizardTestDom();

const SAVED_SECRET_ID = parseUuidV7("0190a3b2-0000-7000-8000-000000000001");

/**
 * `TokenCredentialForm` has its own tests. This fake hands back an unsaved
 * verified token so these tests cover only the step: which options it shows
 * and what it hands to `onCreate`.
 */
void mock.module("@/components/integrations/token-credential-form", () => ({
  TokenCredentialForm: (props: {
    platform: string;
    onVerified: (verified: VerifiedCredential) => void;
    renderError?: (failure: CredentialCheckFailure) => ReactNode;
  }) => {
    const [failure, setFailure] = useState<CredentialCheckFailure | null>(null);
    return (
      <>
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
          Verify {props.platform} token
        </button>
        <button
          onClick={() => {
            props.onVerified({
              credential: { secretId: SAVED_SECRET_ID },
              connection: { method: "saved", name: "Team key" },
              account: "octocat",
              repo:
                props.platform === "jira"
                  ? null
                  : { id: 7, fullName: "acme/api" },
            });
          }}
        >
          Use saved {props.platform} key
        </button>
        <button
          onClick={() => {
            setFailure({
              ok: false,
              message: "Issues are off",
              code: "BITBUCKET_ISSUES_DISABLED",
            });
          }}
        >
          Fail {props.platform} check
        </button>
        {failure ? (props.renderError?.(failure) ?? failure.message) : null}
      </>
    );
  },
}));

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IssueTrackerStep } = await import("./issue-tracker-step");

const INSTALL_HREF = "/api/integrations/github/install?returnTo=x";

const renderStep = (
  check: ReturnType<typeof buildRepoCheck>,
  {
    githubAppConfigured = true,
    onCreate = mock(() => {}),
  }: { githubAppConfigured?: boolean; onCreate?: () => void } = {},
) =>
  render(
    <IssueTrackerStep
      gitUrl="https://github.com/acme/api"
      check={check}
      repoName="acme/api"
      githubAppConfigured={githubAppConfigured}
      installHref={INSTALL_HREF}
      isCreating={false}
      createError={null}
      onBack={() => {}}
      onCreate={onCreate}
    />,
  );

const optionNames = (view: ReturnType<typeof render>) =>
  view.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"));

describe("IssueTrackerStep", () => {
  afterEach(() => {
    cleanup();
  });

  test("a GitHub repo offers the App first, recommended, then a token and Jira", () => {
    const view = renderStep(buildRepoCheck());

    expect(optionNames(view)).toEqual(["GitHub App", "GitHub token", "Jira"]);
    expect(view.getAllByText("Recommended")).toHaveLength(1);
    expect(
      (view.getByRole("radio", { name: "GitHub App" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  test("the App is hidden when it isn't configured", () => {
    const view = renderStep(buildRepoCheck(), { githubAppConfigured: false });

    expect(optionNames(view)).toEqual(["GitHub token", "Jira"]);
    expect(view.queryByText("Recommended")).toBeNull();
  });

  test("a Bitbucket repo offers a Bitbucket token, then Jira", () => {
    const view = renderStep(buildRepoCheck({ host: "bitbucket" }));

    expect(optionNames(view)).toEqual(["Bitbucket token", "Jira"]);
    expect(
      (view.getByRole("radio", { name: "Bitbucket token" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      view.getByRole("button", { name: "Verify bitbucket token" }),
    ).toBeTruthy();
  });

  test("other hosts offer only Jira", () => {
    const view = renderStep(buildRepoCheck({ host: "other" }));
    expect(optionNames(view)).toEqual(["Jira"]);
  });

  test("a Bitbucket repo with issues off suggests Jira and switches to it", () => {
    const view = renderStep(buildRepoCheck({ host: "bitbucket" }));

    fireEvent.click(view.getByRole("button", { name: "Fail bitbucket check" }));
    expect(
      view.getByText(
        "This repo's issue tracker is off. Many Bitbucket teams use Jira. Connect Jira instead?",
      ),
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Connect Jira" }));
    expect(
      (view.getByRole("radio", { name: "Jira" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  test("with no covering installation it offers to install the App", () => {
    const view = renderStep(buildRepoCheck({ githubApp: null }));

    const install = view.getByRole("link", {
      name: "Install the GitHub App on acme/api",
    });
    expect(install.getAttribute("href")).toBe(INSTALL_HREF);
    expect(
      view.getByText(/Needs admin access to the repo or org/),
    ).toBeTruthy();
    expect(
      (
        view.getByRole("button", {
          name: "Create project",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("a covering installation is ready to create via the App", () => {
    const onCreate = mock(() => {});
    const view = renderStep(
      buildRepoCheck({
        githubApp: { installationId: "42", accountLogin: "acme" },
      }),
      { onCreate },
    );

    expect(view.getByText("Connected through GitHub App (acme).")).toBeTruthy();
    expect(view.getByText(/Issues will sync via GitHub App\./)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Create project" }));
    expect(onCreate).toHaveBeenCalledWith(
      {
        type: "github_app",
        installationId: "42",
        accountLogin: "acme",
      },
      7,
    );
  });

  test("the first-sync range can be extended to 180 days", () => {
    const onCreate = mock(() => {});
    const view = renderStep(
      buildRepoCheck({
        githubApp: { installationId: "42", accountLogin: "acme" },
      }),
      { onCreate },
    );

    fireEvent.mouseDown(
      view.getByRole("combobox", { name: "First sync: issues updated within" }),
    );
    fireEvent.click(view.getByRole("option", { name: "Last 180 days" }));
    fireEvent.click(view.getByRole("button", { name: "Create project" }));

    expect(onCreate).toHaveBeenCalledWith(
      { type: "github_app", installationId: "42", accountLogin: "acme" },
      180,
    );
  });

  test("a checked unsaved token shows the summary and is handed to create", () => {
    const onCreate = mock(() => {});
    const view = renderStep(buildRepoCheck(), { onCreate });

    fireEvent.click(view.getByRole("radio", { name: "GitHub token" }));
    fireEvent.click(view.getByRole("button", { name: "Verify github token" }));

    expect(
      view.getByText(
        "Issues will sync via your token (not saved). Syncs run only when you ask for them.",
      ),
    ).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Create project" }));
    expect(onCreate).toHaveBeenCalledWith(
      {
        type: "github_token",
        verified: {
          credential: { token: "ghp_secret" },
          connection: { method: "unsaved" },
          account: "octocat",
          repo: { id: 7, fullName: "acme/api" },
        },
      },
      7,
    );
  });

  const autoSyncBox = (view: ReturnType<typeof render>) =>
    view.queryByRole("checkbox", { name: "Auto-sync with this key" });

  test("a saved GitHub token offers auto-sync, unchecked, with the consent and App hint", () => {
    const view = renderStep(buildRepoCheck());

    fireEvent.click(view.getByRole("radio", { name: "GitHub token" }));
    fireEvent.click(view.getByRole("button", { name: "Use saved github key" }));

    expect((autoSyncBox(view) as HTMLInputElement).checked).toBe(false);
    expect(
      view.getByText(/Scarn will read issues from acme\/api using your GitHub/),
    ).toBeTruthy();
    expect(view.getByText(/Installing the GitHub App is better/)).toBeTruthy();
  });

  test("checking auto-sync on a saved GitHub token hands autoSync to create", () => {
    const onCreate = mock(() => {});
    const view = renderStep(buildRepoCheck(), { onCreate });

    fireEvent.click(view.getByRole("radio", { name: "GitHub token" }));
    fireEvent.click(view.getByRole("button", { name: "Use saved github key" }));
    fireEvent.click(autoSyncBox(view) as HTMLElement);

    expect(view.getByText(/Syncs run every 5 minutes\./)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Create project" }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: "github_token", autoSync: true }),
      7,
    );
  });

  test("checking auto-sync on a saved Jira key hands autoSync to create", () => {
    const onCreate = mock(() => {});
    const view = renderStep(buildRepoCheck({ host: "other" }), { onCreate });

    fireEvent.change(view.getByLabelText(/Project keys/), {
      target: { value: "ABC" },
    });
    fireEvent.click(view.getByRole("button", { name: "Use saved jira key" }));
    expect(
      view.getByText(/Scarn will read issues from ABC using your Jira/),
    ).toBeTruthy();
    fireEvent.click(autoSyncBox(view) as HTMLElement);
    fireEvent.click(view.getByRole("button", { name: "Create project" }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "jira",
        projectKeys: ["ABC"],
        autoSync: true,
      }),
      7,
    );
  });

  test("a saved key left unchecked is created without autoSync", () => {
    const onCreate = mock(() => {});
    const view = renderStep(buildRepoCheck(), { onCreate });

    fireEvent.click(view.getByRole("radio", { name: "GitHub token" }));
    fireEvent.click(view.getByRole("button", { name: "Use saved github key" }));
    fireEvent.click(view.getByRole("button", { name: "Create project" }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ autoSync: true }),
      7,
    );
  });

  test("auto-sync isn't offered for a pasted token, Bitbucket or the App", () => {
    const view = renderStep(
      buildRepoCheck({
        githubApp: { installationId: "42", accountLogin: "acme" },
      }),
    );
    expect(autoSyncBox(view)).toBeNull();

    fireEvent.click(view.getByRole("radio", { name: "GitHub token" }));
    fireEvent.click(view.getByRole("button", { name: "Verify github token" }));
    expect(autoSyncBox(view)).toBeNull();
    cleanup();

    const bitbucket = renderStep(buildRepoCheck({ host: "bitbucket" }));
    fireEvent.click(
      bitbucket.getByRole("button", { name: "Use saved bitbucket key" }),
    );
    expect(autoSyncBox(bitbucket)).toBeNull();
  });

  test("Skip for now creates with no issue tracker", () => {
    const onCreate = mock(() => {});
    const view = renderStep(buildRepoCheck(), { onCreate });

    fireEvent.click(view.getByRole("button", { name: "Skip for now" }));
    expect(onCreate).toHaveBeenCalledWith(null);
  });
});
