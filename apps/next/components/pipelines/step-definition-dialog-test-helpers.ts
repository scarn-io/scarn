import { mock } from "bun:test";
import { fireEvent } from "@testing-library/react";
import {
  parseUuidV7,
  type StepDefinitionContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

export const projectId = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";

export type SavedStepBody = {
  healthChecksJson: unknown;
  environment: StepDefinitionContract["environment"];
  repo: unknown;
};

export function editTextInput(input: HTMLInputElement, value: string) {
  fireEvent.focusIn(input);
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  );
  descriptor?.set?.call(input, value);
  fireEvent.input(input);
  fireEvent.keyUp(input, { key: "d" });
}

export function makeStep(
  overrides: Partial<StepDefinitionContract> = {},
): StepDefinitionContract {
  return {
    id: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe201"),
    projectId: parseUuidV7(projectId),
    key: "browser-repro",
    name: "Browser Repro",
    description: null,
    prompt: "Open the app.",
    version: 1,
    kind: "user_defined",
    entrypointJson: null,
    toolCallJson: null,
    environment: null,
    inputSchemaJson: {},
    resultSchemaJson: {},
    errors: [],
    retry: [],
    grants: [],
    maxTurns: null,
    concurrency: null,
    opencodeMcpJson: null,
    healthChecksJson: [
      {
        kind: "tool",
        tool: "browser_navigate",
        mcp: "browser",
        args: { url: "about:blank" },
        severity: "required",
        timeoutSeconds: 15,
      },
    ],
    repo: {
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      baseBranch: null,
      workBranch: { kind: "create" },
    },
    status: "active",
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  };
}

export function setupDom() {
  const dom = installDom({ url: "http://localhost/" });
  Object.assign(globalThis, {
    navigator: Object.assign(Object.create(null), dom.window.navigator, {
      clipboard: { writeText: mock(() => Promise.resolve()) },
    }) as typeof navigator,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb: FrameRequestCallback) =>
      setTimeout(() => {
        cb(Date.now());
      }, 0) as unknown as number,
    cancelAnimationFrame: (id: number) => {
      clearTimeout(id);
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
  type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
  (
    dom.window.HTMLInputElement.prototype as unknown as WithIeEvents
  ).attachEvent = () => {};
  (
    dom.window.HTMLInputElement.prototype as unknown as WithIeEvents
  ).detachEvent = () => {};
  (dom.window.Element.prototype as unknown as WithIeEvents).attachEvent =
    () => {};
  (dom.window.Element.prototype as unknown as WithIeEvents).detachEvent =
    () => {};
}
