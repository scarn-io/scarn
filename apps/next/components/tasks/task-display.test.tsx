import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "@/tests/support/install-dom";
import { TaskKindIcon, taskKindLabel } from "./task-display";

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
