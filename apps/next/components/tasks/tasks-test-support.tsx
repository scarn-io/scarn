/**
 * Shared jsdom setup, API client fake and fixtures for the Tasks component
 * tests. The module mocks live here so every Tasks test file shares one fake.
 */
import { mock } from "bun:test";
import type { ReactNode } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { TaskRunContract } from "@scarn/api/frontend-contracts";
import type { TaskSummary } from "./task-api";
import { installDom as installTestDom } from "@/tests/support/install-dom";

export const projectId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");
export const workItemId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901");

type FakeEnvironmentContent = {
  connectors?: string[];
  vars?: { name: string; source: "secret"; secret: string }[];
};

export const api = {
  postBodies: [] as Record<string, unknown>[],
  stepDefinitions: [] as {
    id: string;
    key: string;
    name: string;
    version: number;
    environment?: unknown;
    opencodeMcpJson?: Record<string, unknown> | null;
  }[],
  environments: {} as Record<string, FakeEnvironmentContent>,
  connectors: [] as {
    id: string;
    name: string;
    description: string;
    auth: "none";
    requiredVars: { name: string; description: string }[];
  }[],
  secretNames: [] as string[],
  secretPosts: [] as { name: string; value: string }[],
  createSecretError: null as unknown,
  createTaskError: null as unknown,
  pushes: [] as string[],
  taskDetail: null as unknown,
  taskDetailRequests: 0,
  taskRuns: [] as unknown[],
  taskRunsRequests: 0,
  retryBodies: [] as { expectedLatestRunId: string | null }[],
  retry: () =>
    Promise.resolve({
      data: {
        taskId: "019e9a92-b432-73e8-9341-3519156fa801",
        taskRunId: null as string | null,
      },
      error: null as { value: { code: string } } | null,
    }),
};

const createTask = (body: Record<string, unknown>) => {
  api.postBodies.push(body);
  if (api.createTaskError !== null) {
    return Promise.resolve({
      data: null,
      error: { status: 422, value: api.createTaskError },
    });
  }
  return Promise.resolve({
    data: {
      task: { id: "019e9a92-b432-73e8-9341-3519156fa9ff" },
      run: null,
    },
    error: null,
  });
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        "pipeline-definitions": {
          get: () => Promise.resolve({ data: [], error: null }),
        },
        environments: Object.assign(
          ({ name }: { name: string }) => ({
            get: () => {
              const content = api.environments[name];
              return Promise.resolve(
                content
                  ? { data: { version: { content } }, error: null }
                  : { data: null, error: { status: 404, value: {} } },
              );
            },
          }),
          {
            get: () =>
              Promise.resolve({
                data: Object.keys(api.environments).map((name) => ({
                  name,
                  description: null,
                })),
                error: null,
              }),
          },
        ),
        secrets: {
          get: () =>
            Promise.resolve({
              data: api.secretNames.map((name) => ({ name })),
              error: null,
            }),
          post: (body: { name: string; value: string }) => {
            api.secretPosts.push(body);
            if (api.createSecretError !== null) {
              return Promise.resolve({
                data: null,
                error: { status: 422, value: api.createSecretError },
              });
            }
            return Promise.resolve({
              data: { name: body.name, lastFour: body.value.slice(-4) },
              error: null,
            });
          },
        },
      }),
      connectors: {
        get: () => Promise.resolve({ data: api.connectors, error: null }),
      },
      "step-definitions": {
        get: () => Promise.resolve({ data: api.stepDefinitions, error: null }),
      },
      "pipeline-executions": {
        get: () =>
          Promise.resolve({
            data: {
              items: [],
              pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
            },
            error: null,
          }),
      },
      tasks: Object.assign(
        () => ({
          get: () => {
            api.taskDetailRequests += 1;
            return Promise.resolve({ data: api.taskDetail, error: null });
          },
          runs: {
            get: () => {
              api.taskRunsRequests += 1;
              return Promise.resolve({ data: api.taskRuns, error: null });
            },
          },
          retry: {
            post: (body: { expectedLatestRunId: string | null }) => {
              api.retryBodies.push(body);
              return api.retry();
            },
          },
        }),
        { post: createTask },
      ),
      "task-runs": () => ({
        logs: {
          get: () =>
            Promise.resolve({
              data: { lines: [], nextOffset: 0, complete: true },
              error: null,
            }),
          archive: {
            get: () => Promise.resolve({ data: { url: null }, error: null }),
          },
        },
      }),
    },
  }),
}));

void mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      api.pushes.push(href);
    },
    refresh: () => {},
  }),
  usePathname: () => "/alice/demo/tasks",
  notFound: () => {
    throw new Error("notFound");
  },
}));

export function resetApi() {
  api.postBodies.length = 0;
  api.stepDefinitions.length = 0;
  api.environments = {};
  api.connectors = [];
  api.secretNames = [];
  api.secretPosts = [];
  api.createSecretError = null;
  api.createTaskError = null;
  api.pushes.length = 0;
  api.taskDetail = null;
  api.taskDetailRequests = 0;
  api.taskRuns = [];
  api.taskRunsRequests = 0;
  api.retryBodies = [];
  api.retry = () =>
    Promise.resolve({
      data: { taskId: "019e9a92-b432-73e8-9341-3519156fa801", taskRunId: null },
      error: null,
    });
}

/**
 * Installed at import time: React DOM decides when it loads whether the DOM
 * can emit `input` events, so test files import Testing Library after this.
 */
function installDom() {
  const dom = installTestDom({ pretendToBeVisual: true });
  Object.assign(globalThis, {
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => {
        callback(Date.now());
      }, 0),
    cancelAnimationFrame: (handle: number) => {
      clearTimeout(handle);
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        addEventListener() {},
        addListener() {},
        dispatchEvent() {
          return false;
        },
        matches: false,
        media: query,
        onchange: null,
        removeEventListener() {},
        removeListener() {},
      }) as MediaQueryList,
  });
}

installDom();

export async function withProjectRoute(
  children: ReactNode,
  permissions: string[] = [],
  isMember = true,
) {
  const { ProjectRouteProvider } =
    await import("@/components/project-route-context");
  return (
    <ProjectRouteProvider
      username="alice"
      projectSlug="demo"
      projectId={projectId}
      isMember={isMember}
      permissions={permissions}
    >
      {children}
    </ProjectRouteProvider>
  );
}

export function buildTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
    projectId,
    kind: "agent",
    name: null,
    status: "running",
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    waitingOnYou: false,
    waitingOn: [],
    conversationId: null,
    workItem: { id: workItemId, platformKey: "GH-12", title: "Fix the bug" },
    repoConversation: null,
    startedBy: {
      kind: "user",
      userId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa700"),
      username: "alice",
    },
    source: {
      kind: "step_definition",
      stepDefinitionId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa600"),
      key: "implement",
      name: "Implement",
      version: 3,
    },
    pipelineRunId: null,
    nodeId: null,
    pipelineRun: null,
    runNumber: 1,
    durationMs: null,
    latest: null,
    ...overrides,
  };
}

export function buildTaskRun(
  overrides: Partial<TaskRunContract> = {},
): TaskRunContract {
  return {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa811"),
    taskId: buildTask().id,
    projectId,
    workItemId,
    number: 1,
    reason: "initial",
    kind: "agent",
    status: "failed",
    taskExecutionConfigId: null,
    name: null,
    previousTaskRunId: null,
    baseBranch: null,
    baseCommit: null,
    heartbeatSeconds: null,
    inputJson: null,
    claimedBy: null,
    claimedAt: null,
    lastHeartbeatAt: null,
    leaseExpiresAt: null,
    executionTimeoutSeconds: null,
    executionDeadlineAt: null,
    startedAt: null,
    completedAt: null,
    resultJson: null,
    errorJson: null,
    workBranch: null,
    createdFromBranch: null,
    sessionRestored: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}
