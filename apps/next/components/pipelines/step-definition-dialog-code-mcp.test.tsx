import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  makeStep,
  projectId,
  setupDom,
} from "./step-definition-dialog-test-helpers";

const putMock = mock(() => Promise.resolve({ data: null, error: null }));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": { put: putMock, post: putMock },
      projects: () => ({
        "mcp-connections": {
          get: () => Promise.resolve({ data: [], error: null }),
        },
      }),
    },
  }),
}));

const { StepDefinitionDialog } = await import("./step-definition-dialog");

const codeStep = makeStep({
  key: "sync-db",
  name: "Sync DB",
  kind: "code",
  prompt: null,
  entrypointJson: { sourceFile: "steps/sync-db.ts" },
  environment: {
    kind: "inline",
    runtime: { kind: "managed", id: "bun1" },
    envJson: null,
  },
  opencodeMcpJson: {
    db: { type: "local", command: ["db-mcp", "--readonly"] },
  },
  healthChecksJson: [
    {
      kind: "tool",
      name: "db.ping",
      tool: "ping",
      mcp: "db",
      severity: "required",
      timeoutSeconds: 15,
      serialGroup: "db",
    },
  ],
});

describe("StepDefinitionDialog for a code step with MCP servers", () => {
  beforeEach(() => {
    setupDom();
    putMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("lists the code step's MCP servers and their checks", () => {
    const view = render(
      <StepDefinitionDialog
        open
        projectId={projectId}
        step={codeStep}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );

    const card = view.baseElement.querySelector(
      '[data-testid="mcp-server-db"]',
    );
    expect(card?.textContent).toContain("db-mcp --readonly");
    expect(card?.textContent).toContain("db.ping → ping");
  });
});
