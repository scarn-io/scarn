import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  GitHubTokenSecretContract,
  JiraApiKeySecretContract,
} from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { installDom } from "@/tests/support/install-dom";

/**
 * The DOM globals are installed before React DOM and Testing Library load
 * (hence the dynamic imports below). React DOM decides at import time whether
 * the DOM can emit `input` events, and without that `fireEvent.change` never
 * reaches a controlled field's `onChange` in this harness.
 */
installDom();

type ApiResult = { data: unknown; error: unknown };

let listResult: ApiResult = { data: [], error: null };
const listCalls: { query: { kind: string } }[] = [];

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      me: {
        secrets: {
          get: (options: { query: { kind: string } }) => {
            listCalls.push(options);
            return Promise.resolve(listResult);
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
const { IntegrationCredentialDialog } =
  await import("./integration-credential-dialog");
const { defaultSavedCredentialOption } =
  await import("./saved-credential-list");

type KeyOverrides = Partial<Omit<JiraApiKeySecretContract, "id">> & {
  id?: string;
};

const buildKey = (overrides: KeyOverrides = {}): JiraApiKeySecretContract =>
  ({
    id: "0198f2c4-0000-7000-8000-000000000001",
    kind: "jira_api_key",
    name: "Work Jira",
    metadata: { email: "work@acme.test" },
    lastFour: "ab12",
    expiresAt: "2027-06-01T00:00:00.000Z",
    lastUsedAt: null,
    status: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  }) as JiraApiKeySecretContract;

const radio = (view: ReturnType<typeof render>, name: RegExp) =>
  view.getByRole("radio", { name }) as HTMLInputElement;

const renderDialog = (onConfirm = mock(() => {})) =>
  render(
    <IntegrationCredentialDialog
      platform="jira"
      open
      onClose={() => {}}
      onConfirm={onConfirm}
      confirmLabel="Sync"
    />,
  );

describe("IntegrationCredentialDialog (Jira)", () => {
  beforeEach(() => {
    listResult = { data: [], error: null };
    listCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("fetches the caller's Jira API keys when it opens", async () => {
    const view = renderDialog();

    await waitFor(() => {
      expect(view.getByLabelText("API token")).toBeTruthy();
    });
    expect(listCalls).toEqual([{ query: { kind: "jira_api_key" } }]);
  });

  test("with no saved keys it opens to the paste fields, pre-fills the email, and links to Account settings", async () => {
    const view = renderDialog();

    await waitFor(() => {
      expect(view.getByLabelText("API token")).toBeTruthy();
    });
    expect(view.queryByRole("radio")).toBeNull();
    expect(
      (view.getByLabelText("Atlassian email") as HTMLInputElement).value,
    ).toBe("me@scarn.test");
    const link = view.getByRole("link", { name: "Save a key for next time" });
    expect(link.getAttribute("href")).toBe("/account/settings");
    const token = view.getByLabelText("API token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.getAttribute("autocomplete")).toBe("off");
  });

  test("pasting returns { email, apiKey } and clears the token afterwards", async () => {
    const onConfirm = mock(() => {});
    const view = renderDialog(onConfirm);

    await waitFor(() => {
      expect(view.getByLabelText("API token")).toBeTruthy();
    });
    fireEvent.change(view.getByLabelText("Atlassian email"), {
      target: { value: "Other@Acme.test " },
    });
    fireEvent.change(view.getByLabelText("API token"), {
      target: { value: "pasted-token" },
    });
    fireEvent.click(view.getByRole("button", { name: "Sync" }));

    expect(onConfirm).toHaveBeenCalledWith({
      email: "Other@Acme.test",
      apiKey: "pasted-token",
    });
    expect((view.getByLabelText("API token") as HTMLInputElement).value).toBe(
      "",
    );
  });

  test("the confirm button stays disabled until a token is pasted", async () => {
    const view = renderDialog();

    await waitFor(() => {
      expect(view.getByLabelText("API token")).toBeTruthy();
    });
    expect(
      (view.getByRole("button", { name: "Sync" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("selects the most recently used key by default and returns { secretId }", async () => {
    const older = buildKey({
      id: "0198f2c4-0000-7000-8000-000000000001",
      name: "Old key",
      lastUsedAt: "2026-09-01T00:00:00.000Z",
    });
    const recent = buildKey({
      id: "0198f2c4-0000-7000-8000-000000000002",
      name: "Recent key",
      lastUsedAt: "2026-10-01T00:00:00.000Z",
    });
    listResult = { data: [older, recent], error: null };
    const onConfirm = mock(() => {});
    const view = renderDialog(onConfirm);

    await waitFor(() => {
      expect(radio(view, /Recent key/).checked).toBe(true);
    });
    expect(radio(view, /Old key/).checked).toBe(false);
    expect(view.queryByLabelText("API token")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Sync" }));

    expect(onConfirm).toHaveBeenCalledWith({ secretId: recent.id });
  });

  test("picking a different saved key returns that key's secretId", async () => {
    const first = buildKey({ name: "First" });
    const second = buildKey({
      id: "0198f2c4-0000-7000-8000-000000000002",
      name: "Second",
    });
    listResult = { data: [first, second], error: null };
    const onConfirm = mock(() => {});
    const view = renderDialog(onConfirm);

    await waitFor(() => {
      expect(radio(view, /First/).checked).toBe(true);
    });
    fireEvent.click(radio(view, /Second/));
    fireEvent.click(view.getByRole("button", { name: "Sync" }));

    expect(onConfirm).toHaveBeenCalledWith({ secretId: second.id });
  });

  test("expired keys are shown but disabled, and never selected by default", async () => {
    const expired = buildKey({
      name: "Stale key",
      status: "expired",
      lastUsedAt: "2026-10-01T00:00:00.000Z",
    });
    listResult = { data: [expired], error: null };
    const view = renderDialog();

    await waitFor(() => {
      expect(view.getByText("Expired — replace it in Account settings"));
    });
    expect(radio(view, /Stale key/).disabled).toBe(true);
    expect(radio(view, /Paste a key instead/).checked).toBe(true);
    expect(view.getByLabelText("API token")).toBeTruthy();
    expect(view.queryByRole("link", { name: "Save a key for next time" })).toBe(
      null,
    );
  });

  test("with saved keys, choosing 'Paste a key instead' shows the paste fields", async () => {
    listResult = { data: [buildKey()], error: null };
    const onConfirm = mock(() => {});
    const view = renderDialog(onConfirm);

    await waitFor(() => {
      expect(radio(view, /Work Jira/).checked).toBe(true);
    });
    fireEvent.click(radio(view, /Paste a key instead/));
    fireEvent.change(view.getByLabelText("API token"), {
      target: { value: "pasted-token" },
    });
    fireEvent.click(view.getByRole("button", { name: "Sync" }));

    expect(onConfirm).toHaveBeenCalledWith({
      email: "me@scarn.test",
      apiKey: "pasted-token",
    });
  });

  test("falls back to the paste fields when the key list can't be loaded", async () => {
    listResult = { data: null, error: { status: 500, value: {} } };
    const view = renderDialog();

    await waitFor(() => {
      expect(view.getByLabelText("API token")).toBeTruthy();
    });
    expect(view.getByText(/Couldn't load your saved API keys/)).toBeTruthy();
  });
});

describe("IntegrationCredentialDialog (GitHub)", () => {
  beforeEach(() => {
    listResult = { data: [], error: null };
    listCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  const renderGitHub = (onConfirm = mock(() => {})) =>
    render(
      <IntegrationCredentialDialog
        platform="github"
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        confirmLabel="Sync"
      />,
    );

  test("lists saved GitHub tokens and pastes a { token } with no email field", async () => {
    const saved = {
      ...buildKey({ name: "Personal GitHub" }),
      kind: "github_token",
      metadata: { login: "octo-cat" },
    } as unknown as GitHubTokenSecretContract;
    listResult = { data: [saved], error: null };
    const onConfirm = mock(() => {});
    const view = renderGitHub(onConfirm);

    await waitFor(() => {
      expect(radio(view, /Personal GitHub/).checked).toBe(true);
    });
    expect(listCalls).toEqual([{ query: { kind: "github_token" } }]);
    expect(view.getByText("octo-cat · ••••ab12")).toBeTruthy();

    fireEvent.click(radio(view, /Paste a key instead/));
    expect(view.queryByLabelText("Atlassian email")).toBeNull();
    fireEvent.change(view.getByLabelText("GitHub token"), {
      target: { value: "ghp_pasted" },
    });
    fireEvent.click(view.getByRole("button", { name: "Sync" }));

    expect(onConfirm).toHaveBeenCalledWith({ token: "ghp_pasted" });
    expect(
      (view.getByLabelText("GitHub token") as HTMLInputElement).value,
    ).toBe("");
  });
});

describe("defaultSavedCredentialOption", () => {
  test("prefers the most recently used usable key", () => {
    expect(
      defaultSavedCredentialOption([
        buildKey({ id: "a", lastUsedAt: null }),
        buildKey({
          id: "b",
          lastUsedAt: "2026-09-01T00:00:00.000Z",
        }),
        buildKey({
          id: "c",
          lastUsedAt: "2026-10-01T00:00:00.000Z",
          status: "expired",
        }),
      ]),
    ).toBe("b");
  });

  test("falls back to the first usable key when none have been used", () => {
    expect(
      defaultSavedCredentialOption([
        buildKey({ id: "a", status: "expired" }),
        buildKey({ id: "b" }),
      ]),
    ).toBe("b");
  });

  test("returns the new-credential option when every key is expired or there are none", () => {
    expect(defaultSavedCredentialOption([])).toBe("new");
    expect(
      defaultSavedCredentialOption([buildKey({ status: "expired" })]),
    ).toBe("new");
  });
});
