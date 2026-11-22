/**
 * Shared jsdom setup, API client fake and fixtures for the repo conversation
 * component tests. The module mocks live here so every test file in this
 * folder shares one fake.
 */
import { mock } from "bun:test";
import type { ReactNode } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { RepoConversation } from "./repo-conversation-api";
import { installDom as installTestDom } from "@/tests/support/install-dom";

export const projectId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");
export const conversationId = parseUuidV7(
  "019e9a92-b432-73e8-9341-3519156fa930",
);

type EdenReply = {
  data: unknown;
  error: { status: number; value: unknown } | null;
};

export const api = {
  pushes: [] as string[],
  replaces: [] as string[],
  /** What `GET /conversations/:id` answers; tests replace it. */
  get: (): Promise<EdenReply> =>
    Promise.resolve({ data: buildConversation(), error: null }),
  getCalls: 0,
  replyBodies: [] as { body: string }[],
  reply: (): Promise<EdenReply> =>
    Promise.resolve({ data: buildConversation(), error: null }),
  retryBodies: [] as { expectedLatestRunId: string | null }[],
  retry: (): Promise<EdenReply> =>
    Promise.resolve({ data: buildConversation(), error: null }),
  endCalls: 0,
  end: (): Promise<EdenReply> =>
    Promise.resolve({
      data: buildConversation({ state: "ended" }),
      error: null,
    }),
  deleteCalls: 0,
  remove: (): Promise<EdenReply> =>
    Promise.resolve({ data: null, error: null }),
};

/**
 * Registered again before every test: other folders' test supports mock the
 * same modules, and in a combined run whichever registered last would win.
 */
function installMocks() {
  void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
    getBrowserScarnApiClient: () => ({
      api: {
        conversations: () => ({
          get: () => {
            api.getCalls += 1;
            return api.get();
          },
          messages: {
            post: (body: { body: string }) => {
              api.replyBodies.push(body);
              return api.reply();
            },
          },
          retry: {
            post: (body: { expectedLatestRunId: string | null }) => {
              api.retryBodies.push(body);
              return api.retry();
            },
          },
          end: {
            post: () => {
              api.endCalls += 1;
              return api.end();
            },
          },
          delete: () => {
            api.deleteCalls += 1;
            return api.remove();
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
      replace: (href: string) => {
        api.replaces.push(href);
      },
      refresh: () => {},
      prefetch: () => {},
    }),
    usePathname: () => "/alice/demo/conversations",
    useSearchParams: () => new URLSearchParams(),
    notFound: () => {
      throw new Error("notFound");
    },
  }));
}

installMocks();

export function resetApi() {
  installMocks();
  api.pushes.length = 0;
  api.replaces.length = 0;
  api.get = () => Promise.resolve({ data: buildConversation(), error: null });
  api.getCalls = 0;
  api.replyBodies.length = 0;
  api.reply = () => Promise.resolve({ data: buildConversation(), error: null });
  api.retryBodies.length = 0;
  api.retry = () => Promise.resolve({ data: buildConversation(), error: null });
  api.endCalls = 0;
  api.end = () =>
    Promise.resolve({
      data: buildConversation({ state: "ended" }),
      error: null,
    });
  api.deleteCalls = 0;
  api.remove = () => Promise.resolve({ data: null, error: null });
}

/** A problem-details failure as Eden returns it. */
export function failWith(status: number, code: string): Promise<EdenReply> {
  return Promise.resolve({
    data: null,
    error: { status, value: { status, code, detail: code } },
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
  type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
  for (const prototype of [
    dom.window.HTMLTextAreaElement.prototype,
    dom.window.Element.prototype,
  ]) {
    (prototype as unknown as WithIeEvents).attachEvent = () => {};
    (prototype as unknown as WithIeEvents).detachEvent = () => {};
  }
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

export function buildConversation(
  overrides: Partial<RepoConversation> = {},
): RepoConversation {
  return {
    id: conversationId,
    projectId,
    workItemId: null,
    status: "agent_turn",
    messages: [],
    visit: null,
    endsWith: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    closedAt: null,
    taskId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
    creator: null,
    context: {
      kind: "project_repo",
      repository: "https://github.com/acme/demo",
      branch: null,
      commit: null,
      pinnedAt: null,
    },
    state: "queued",
    latestRun: null,
    error: null,
    capabilities: {
      canReply: true,
      canRetry: true,
      canEnd: true,
      canDelete: true,
    },
    ...overrides,
  };
}

export const CHAT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const CHAT_RUN_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa990");

const chatMessages: RepoConversation["messages"] = [
  {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa931"),
    authorKind: "person",
    authorName: "alice",
    taskRunId: null,
    body: "Where is auth handled?",
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa932"),
    authorKind: "agent",
    authorName: null,
    taskRunId: CHAT_RUN_ID,
    body: "In the auth middleware.",
    createdAt: "2026-10-01T12:01:00.000Z",
  },
];

/** A chat with a question and an answer, pinned to `CHAT_COMMIT` on main. */
export function buildChat(
  overrides: Partial<RepoConversation> = {},
): RepoConversation {
  return buildConversation({
    messages: chatMessages,
    creator: {
      userId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa700"),
      username: "alice",
      image: null,
    },
    context: {
      kind: "project_repo",
      repository: "https://github.com/acme/demo",
      branch: "main",
      commit: CHAT_COMMIT,
      pinnedAt: "2026-10-01T12:00:05.000Z",
    },
    latestRun: { id: CHAT_RUN_ID, status: "succeeded", reason: "initial" },
    ...overrides,
  });
}

/** Makes `GET /conversations/:id` answer `conversation`. */
export function serveConversation(conversation: RepoConversation) {
  api.get = () => Promise.resolve({ data: conversation, error: null });
}

export function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}
