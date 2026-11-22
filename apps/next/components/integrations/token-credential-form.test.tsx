import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installWizardTestDom } from "@/components/projects/new/wizard-test-dom";
import type {
  CreateSecretInput,
  IntegrationCredentialChoice,
} from "@scarn/core/secrets/secret/contracts/secret-contracts";
import type { CredentialCheckResult } from "./token-credential-form";

installWizardTestDom();

type ApiResult = { data: unknown; error: unknown };

const SAVED_SECRET_ID = "0198f2c4-0000-7000-8000-0000000000aa";

let listResult: ApiResult = { data: [], error: null };
let saveResult: ApiResult = {
  data: { id: SAVED_SECRET_ID },
  error: null,
};
const saveCalls: CreateSecretInput[] = [];

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      me: {
        secrets: {
          get: () => Promise.resolve(listResult),
          post: (body: CreateSecretInput) => {
            saveCalls.push(body);
            return Promise.resolve(saveResult);
          },
        },
      },
    },
  }),
}));

void mock.module("@/app/_lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { email: "me@scarn.test" } } }),
  },
}));

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { TokenCredentialForm } = await import("./token-credential-form");
const { BitbucketTokenHelp, BITBUCKET_TOKEN_SCOPES } =
  await import("./bitbucket-token-help");
const { ATLASSIAN_API_TOKENS_URL, defaultExpiryDate } =
  await import("@/components/settings/api-key-form-shared");
const { GitHubTokenHelp } = await import("./github-token-help");
const { githubTokenExpiryDate, githubTokenUrl } =
  await import("@/components/settings/github-token-url");

const okCheck: CredentialCheckResult = {
  ok: true,
  account: "octocat",
  repo: { id: 7, fullName: "acme/api" },
};

const renderForm = (
  check: (
    credential: IntegrationCredentialChoice,
  ) => Promise<CredentialCheckResult>,
  onVerified = mock(() => {}),
) =>
  render(
    <TokenCredentialForm
      platform="github"
      check={check}
      onVerified={onVerified}
    />,
  );

const tokenInput = (view: ReturnType<typeof render>) =>
  view.getByLabelText("GitHub token") as HTMLInputElement;

const saveBox = (view: ReturnType<typeof render>) =>
  view.getByRole("checkbox", {
    name: "Securely save this token to my API keys",
  }) as HTMLInputElement;

const pasteToken = async (view: ReturnType<typeof render>) => {
  await waitFor(() => {
    expect(tokenInput(view)).toBeTruthy();
  });
  fireEvent.change(tokenInput(view), { target: { value: "ghp_secret" } });
};

describe("TokenCredentialForm", () => {
  beforeEach(() => {
    listResult = { data: [], error: null };
    saveResult = { data: { id: SAVED_SECRET_ID }, error: null };
    saveCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("the save box is checked by default and shows name and optional expiry", async () => {
    const view = renderForm(() => Promise.resolve(okCheck));
    await pasteToken(view);

    expect(saveBox(view).checked).toBe(true);
    expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "GitHub token",
    );
    expect(view.getByRole("checkbox", { name: "No expiry" })).toBeTruthy();
    expect((view.getByLabelText("Expiry date") as HTMLInputElement).value).toBe(
      githubTokenExpiryDate(),
    );
    expect(tokenInput(view).getAttribute("autocomplete")).toBe("off");
    expect(tokenInput(view).type).toBe("password");
  });

  test("GitHub help links to a pre-filled token form for the repo's owner", () => {
    const view = render(<GitHubTokenHelp owner="acme" />);

    expect(
      view
        .getByRole("link", { name: "Create a GitHub token" })
        .getAttribute("href"),
    ).toBe(githubTokenUrl({ owner: "acme" }));
  });

  test("checked: checks the pasted token, saves it, and hands back { secretId }", async () => {
    const check = mock((credential: IntegrationCredentialChoice) => {
      void credential;
      return Promise.resolve(okCheck);
    });
    const onVerified = mock(() => {});
    const view = renderForm(check, onVerified);
    await pasteToken(view);

    fireEvent.click(view.getByRole("button", { name: "Check and continue" }));

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledWith({
        credential: { secretId: SAVED_SECRET_ID },
        connection: { method: "saved", name: "GitHub token" },
        account: "octocat",
        repo: { id: 7, fullName: "acme/api" },
      });
    });
    expect(check).toHaveBeenCalledWith({ token: "ghp_secret" });
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toMatchObject({
      kind: "github_token",
      name: "GitHub token",
      value: "ghp_secret",
      login: "octocat",
    });
    expect(tokenInput(view).value).toBe("");
  });

  test("unchecked: makes no secret call and hands back the pasted token", async () => {
    const onVerified = mock(() => {});
    const view = renderForm(() => Promise.resolve(okCheck), onVerified);
    await pasteToken(view);

    fireEvent.click(saveBox(view));
    expect(view.queryByLabelText("Name")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Check and continue" }));

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledWith({
        credential: { token: "ghp_secret" },
        connection: { method: "unsaved" },
        account: "octocat",
        repo: { id: 7, fullName: "acme/api" },
      });
    });
    expect(saveCalls).toEqual([]);
  });

  test("a failed check shows the error, saves nothing and clears the token", async () => {
    const onVerified = mock(() => {});
    const view = renderForm(
      () =>
        Promise.resolve({ ok: false, message: "GitHub rejected that token." }),
      onVerified,
    );
    await pasteToken(view);

    fireEvent.click(view.getByRole("button", { name: "Check and continue" }));

    expect(await view.findByText("GitHub rejected that token.")).toBeTruthy();
    expect(saveCalls).toEqual([]);
    expect(onVerified).not.toHaveBeenCalled();
    expect(tokenInput(view).value).toBe("");
  });

  test("a save error is shown inline and doesn't move on", async () => {
    saveResult = {
      data: null,
      error: {
        value: { status: 409, detail: "You already have a key named that." },
      },
    };
    const onVerified = mock(() => {});
    const view = renderForm(() => Promise.resolve(okCheck), onVerified);
    await pasteToken(view);

    fireEvent.click(view.getByRole("button", { name: "Check and continue" }));

    expect(
      await view.findByText("You already have a key named that."),
    ).toBeTruthy();
    expect(onVerified).not.toHaveBeenCalled();
  });

  test("Bitbucket asks for an email and API token, links to Atlassian, and requires an expiry a year out", async () => {
    const check = mock((credential: IntegrationCredentialChoice) => {
      void credential;
      return Promise.resolve({ ok: true as const, account: "Dev", repo: null });
    });
    const view = render(
      <TokenCredentialForm
        platform="bitbucket"
        help={<BitbucketTokenHelp />}
        check={check}
        onVerified={mock(() => {})}
      />,
    );

    const apiToken = (await view.findByLabelText(
      "API token",
    )) as HTMLInputElement;
    const email = view.getByLabelText("Atlassian email") as HTMLInputElement;
    expect(email.value).toBe("me@scarn.test");
    expect(
      view
        .getByRole("link", { name: "Atlassian API tokens page" })
        .getAttribute("href"),
    ).toBe(ATLASSIAN_API_TOKENS_URL);
    for (const scope of BITBUCKET_TOKEN_SCOPES) {
      expect(view.getByText(scope)).toBeTruthy();
    }
    expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Bitbucket token",
    );
    expect(view.queryByRole("checkbox", { name: "No expiry" })).toBeNull();
    expect((view.getByLabelText("Expiry date") as HTMLInputElement).value).toBe(
      defaultExpiryDate(),
    );

    fireEvent.change(apiToken, { target: { value: "bb-secret" } });
    fireEvent.click(view.getByRole("button", { name: "Check and continue" }));

    await waitFor(() => {
      expect(saveCalls).toHaveLength(1);
    });
    expect(check).toHaveBeenCalledWith({
      email: "me@scarn.test",
      apiToken: "bb-secret",
    });
    expect(saveCalls[0]).toMatchObject({
      kind: "bitbucket_api_token",
      name: "Bitbucket token",
      email: "me@scarn.test",
      value: "bb-secret",
    });
  });

  test("a saved key is checked and handed back as { secretId } without saving", async () => {
    listResult = {
      data: [
        {
          id: SAVED_SECRET_ID,
          kind: "github_token",
          name: "Work GitHub",
          metadata: { login: "octocat" },
          lastFour: "ab12",
          expiresAt: null,
          lastUsedAt: null,
          status: "active",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      error: null,
    };
    const check = mock((credential: IntegrationCredentialChoice) => {
      void credential;
      return Promise.resolve(okCheck);
    });
    const onVerified = mock(() => {});
    const view = renderForm(check, onVerified);

    await view.findByRole("radio", { name: /Work GitHub/ });
    expect(view.getByRole("radio", { name: "Use a new token" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Check and continue" }));

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledWith({
        credential: { secretId: SAVED_SECRET_ID },
        connection: { method: "saved", name: "Work GitHub" },
        account: "octocat",
        repo: { id: 7, fullName: "acme/api" },
      });
    });
    expect(check).toHaveBeenCalledWith({ secretId: SAVED_SECRET_ID });
    expect(saveCalls).toEqual([]);
  });
});
