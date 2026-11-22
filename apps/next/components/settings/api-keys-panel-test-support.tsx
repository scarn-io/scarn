import { mock } from "bun:test";
import type { SecretContract } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { installDom } from "@/tests/support/install-dom";

/**
 * Shared harness for the `ApiKeysPanel` tests. The DOM globals are installed
 * before React DOM and Testing Library load (hence the dynamic imports below).
 * React DOM decides at import time whether the DOM can emit `input` events,
 * and without that `fireEvent.change` never reaches a controlled field's
 * `onChange` in this harness. The browser API client is replaced by a stub
 * that records calls in `apiState`.
 */
installDom();

type ApiResult = { data: unknown; error: unknown };
type ListOptions = { query?: { kind?: SecretContract["kind"] } };

export const apiState = {
  listResult: { data: [], error: null } as ApiResult,
  createResult: { data: null, error: null } as ApiResult,
  renameResult: { data: null, error: null } as ApiResult,
  deleteResult: { data: { deleted: true }, error: null } as ApiResult,
  stopUsingResult: { data: null, error: null } as ApiResult,
  listCalls: [] as (ListOptions | undefined)[],
  createCalls: [] as Record<string, unknown>[],
  renameCalls: [] as { secretId: string; body: { name: string } }[],
  deleteCalls: [] as string[],
  stopUsingCalls: [] as { secretId: string; integrationId: string }[],
};

export const resetApiState = () => {
  apiState.listResult = { data: [], error: null };
  apiState.createResult = { data: null, error: null };
  apiState.renameResult = { data: null, error: null };
  apiState.deleteResult = { data: { deleted: true }, error: null };
  apiState.stopUsingResult = { data: null, error: null };
  apiState.listCalls.length = 0;
  apiState.createCalls.length = 0;
  apiState.renameCalls.length = 0;
  apiState.deleteCalls.length = 0;
  apiState.stopUsingCalls.length = 0;
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      me: {
        secrets: Object.assign(
          (params: { secretId: string }) => ({
            patch: (body: { name: string }) => {
              apiState.renameCalls.push({ secretId: params.secretId, body });
              return Promise.resolve(apiState.renameResult);
            },
            delete: () => {
              apiState.deleteCalls.push(params.secretId);
              return Promise.resolve(apiState.deleteResult);
            },
            uses: ({ integrationId }: { integrationId: string }) => ({
              delete: () => {
                apiState.stopUsingCalls.push({
                  secretId: params.secretId,
                  integrationId,
                });
                return Promise.resolve(apiState.stopUsingResult);
              },
            }),
          }),
          {
            get: (options?: ListOptions) => {
              apiState.listCalls.push(options);
              return Promise.resolve(apiState.listResult);
            },
            post: (body: Record<string, unknown>) => {
              apiState.createCalls.push(body);
              return Promise.resolve(apiState.createResult);
            },
          },
        ),
      },
    },
  }),
}));

export const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
export const { ApiKeysPanel } = await import("./api-keys-panel");
export const { defaultExpiryDate, isFutureDate } =
  await import("./api-key-form-shared");

type KeyOverrides = Partial<Omit<SecretContract, "id">> & { id?: string };

export const buildKey = (overrides: KeyOverrides = {}): SecretContract =>
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
    usedBy: [],
    ...overrides,
  }) as SecretContract;

export const fillForm = (
  view: ReturnType<typeof render>,
  values: { name?: string; email?: string; token?: string; expiry?: string },
) => {
  if (values.name !== undefined)
    fireEvent.change(view.getByLabelText("Name"), {
      target: { value: values.name },
    });
  if (values.email !== undefined)
    fireEvent.change(view.getByLabelText("Atlassian email"), {
      target: { value: values.email },
    });
  if (values.token !== undefined)
    fireEvent.change(view.getByLabelText("API token"), {
      target: { value: values.token },
    });
  if (values.expiry !== undefined)
    fireEvent.change(view.getByLabelText("Expiry date"), {
      target: { value: values.expiry },
    });
};

export const saveButton = (view: ReturnType<typeof render>) =>
  view.getByRole("button", { name: "Save API key" }) as HTMLButtonElement;
