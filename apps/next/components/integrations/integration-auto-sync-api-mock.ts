import { mock } from "bun:test";
import { savedKeys } from "./integration-auto-sync-test-support";
import { installDom } from "@/tests/support/install-dom";

type ApiResult = { data: unknown; error: unknown };

/**
 * Installs the DOM globals (before React DOM loads, so controlled inputs get
 * change events) and a fake API client for the auto-sync component tests.
 */
export const installAutoSyncTestEnvironment = () => {
  installDom();

  const api = {
    listResult: { data: savedKeys, error: null } as ApiResult,
    putResult: { data: null, error: null } as ApiResult,
    deleteResult: { data: null, error: null } as ApiResult,
    putCalls: [] as { integrationId: string; body: { secretId: string } }[],
    deleteCalls: [] as string[],
    reset() {
      api.listResult = { data: savedKeys, error: null };
      api.putResult = { data: null, error: null };
      api.deleteResult = { data: null, error: null };
      api.putCalls.length = 0;
      api.deleteCalls.length = 0;
    },
  };

  void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
    getBrowserScarnApiClient: () => ({
      api: {
        me: {
          secrets: { get: () => Promise.resolve(api.listResult) },
        },
        projects: () => ({
          integrations: ({ integrationId }: { integrationId: string }) => ({
            "auto-sync": {
              put: (body: { secretId: string }) => {
                api.putCalls.push({ integrationId, body });
                return Promise.resolve(api.putResult);
              },
              delete: () => {
                api.deleteCalls.push(integrationId);
                return Promise.resolve(api.deleteResult);
              },
            },
          }),
        }),
      },
    }),
  }));

  return api;
};
