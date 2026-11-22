import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApiKeysPanel,
  apiState,
  buildKey,
  cleanup,
  fillForm,
  fireEvent,
  render,
  resetApiState,
  saveButton,
  within,
} from "./api-keys-panel-test-support";

describe("ApiKeysPanel platform tokens", () => {
  beforeEach(() => {
    resetApiState();
  });

  afterEach(() => {
    cleanup();
  });

  test("lists GitHub and Bitbucket keys with their provider and account", async () => {
    apiState.listResult = {
      data: [
        buildKey({
          id: "0198f2c4-0000-7000-8000-000000000004",
          kind: "github_token",
          name: "Personal GitHub",
          metadata: { login: "octocat" },
          lastFour: "gh12",
          expiresAt: null,
        }),
        buildKey({
          id: "0198f2c4-0000-7000-8000-000000000005",
          kind: "github_token",
          name: "Anonymous GitHub",
          metadata: { login: null },
          lastFour: "gh34",
        }),
        buildKey({
          id: "0198f2c4-0000-7000-8000-000000000006",
          kind: "bitbucket_api_token",
          name: "Work Bitbucket",
          metadata: { email: "bb@acme.test" },
          lastFour: "bb56",
        }),
      ],
      error: null,
    };
    const view = render(<ApiKeysPanel />);

    const github = await view.findByRole("listitem", {
      name: "API key Personal GitHub",
    });
    expect(within(github).getByText("GitHub")).toBeTruthy();
    expect(within(github).getByText("octocat · ••••gh12")).toBeTruthy();
    expect(within(github).getByText(/Never expires/)).toBeTruthy();

    const anonymous = view.getByRole("listitem", {
      name: "API key Anonymous GitHub",
    });
    expect(within(anonymous).getByText("••••gh34")).toBeTruthy();
    expect(within(anonymous).getByText(/Expires/)).toBeTruthy();

    const bitbucket = view.getByRole("listitem", {
      name: "API key Work Bitbucket",
    });
    expect(within(bitbucket).getByText("Bitbucket")).toBeTruthy();
    expect(within(bitbucket).getByText("bb@acme.test · ••••bb56")).toBeTruthy();
  });

  test("the GitHub form saves a token that never expires", async () => {
    apiState.createResult = {
      data: buildKey({
        kind: "github_token",
        name: "Personal GitHub",
        metadata: { login: null },
        expiresAt: null,
      }),
      error: null,
    };
    const view = render(<ApiKeysPanel />);
    await view.findByText("No saved API keys yet.");

    fireEvent.click(view.getByRole("button", { name: "GitHub" }));
    view.getByRole("form", { name: "Add GitHub token" });
    fireEvent.change(view.getByLabelText("Name"), {
      target: { value: "Personal GitHub" },
    });
    const token = view.getByLabelText("GitHub token") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: "ghp_secret" } });
    fireEvent.click(view.getByLabelText("This token never expires"));
    expect(view.queryByLabelText("Expiry date")).toBeNull();
    fireEvent.click(saveButton(view));

    expect(token.value).toBe("");
    await view.findByRole("listitem", { name: "API key Personal GitHub" });
    expect(apiState.createCalls).toEqual([
      {
        kind: "github_token",
        name: "Personal GitHub",
        value: "ghp_secret",
        expiresAt: null,
      },
    ]);
  });

  test("the Bitbucket form requires an expiry and saves the email + token", async () => {
    apiState.createResult = {
      data: buildKey({
        kind: "bitbucket_api_token",
        name: "Work Bitbucket",
        metadata: { email: "bb@acme.test" },
      }),
      error: null,
    };
    const view = render(<ApiKeysPanel />);
    await view.findByText("No saved API keys yet.");

    fireEvent.click(view.getByRole("button", { name: "Bitbucket" }));
    view.getByRole("form", { name: "Add Bitbucket API token" });
    fillForm(view, {
      name: "Work Bitbucket",
      email: "bb@acme.test",
      token: "bb-secret",
      expiry: "",
    });
    expect(saveButton(view).disabled).toBe(true);
    fillForm(view, { expiry: "2099-03-15" });
    fireEvent.click(saveButton(view));

    await view.findByRole("listitem", { name: "API key Work Bitbucket" });
    expect(apiState.createCalls).toHaveLength(1);
    expect(apiState.createCalls[0]).toMatchObject({
      kind: "bitbucket_api_token",
      name: "Work Bitbucket",
      email: "bb@acme.test",
      value: "bb-secret",
    });
    expect(typeof apiState.createCalls[0]?.["expiresAt"]).toBe("string");
  });
});
