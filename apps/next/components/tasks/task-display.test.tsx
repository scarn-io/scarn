import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "@/tests/support/install-dom";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { TaskKindIcon, taskDisplayName, taskKindLabel } from "./task-display";

describe("taskDisplayName", () => {
  const scheduled = (name: string | null) => ({
    name,
    source: { kind: "prompt" as const, promptPreview: "Poll the inbox" },
    startedBy: {
      kind: "schedule" as const,
      automationId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa921"),
      key: "poller",
      title: null,
      schedule: {
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa920"),
        key: "hourly",
        removed: false,
      },
      user: null,
    },
  });

  test("names a scheduled Task by its schedule unless it has a name", () => {
    expect(taskDisplayName(scheduled(null))).toBe("poller · hourly");
    expect(taskDisplayName(scheduled("Sync"))).toBe("Sync");
  });
});

describe("MCP tool task kind", () => {
  beforeEach(() => {
    installDom({ url: "http://localhost/" });
  });

  afterEach(() => {
    cleanup();
  });

  test("is labelled MCP tool", () => {
    expect(taskKindLabel("mcp_tool")).toBe("MCP tool");
  });

  test("has its own icon, distinct from a code step's", () => {
    const view = render(
      <>
        <TaskKindIcon kind="mcp_tool" />
        <TaskKindIcon kind="code" />
      </>,
    );
    const toolIcon = view.getByLabelText("MCP tool");
    const codeIcon = view.getByLabelText("Code step");
    expect(toolIcon.getAttribute("data-testid")).toBe("BuildOutlinedIcon");
    expect(codeIcon.getAttribute("data-testid")).toBe("CodeIcon");
  });
});
