import { describe, expect } from "bun:test";
import {
  isManagedConnectionNotReady,
  managedConnectionNotReadyError,
  MANAGED_CONNECTION_NOT_READY_ERROR,
} from "@/connections/managed-mcp-connection/domain/managed-connection-not-ready";
import { concurrentTest } from "tests/utils";

describe("managedConnectionNotReadyError", () => {
  concurrentTest("names one connection by its label", () => {
    const error = managedConnectionNotReadyError(["Notion"]);
    expect(error.name).toBe(MANAGED_CONNECTION_NOT_READY_ERROR);
    expect(isManagedConnectionNotReady(error)).toBe(true);
    expect(error.message).toStartWith(
      "The project's Notion connection isn't ready, so the run didn't start; a project admin must reconnect it in project settings.",
    );
    expect(error.message).toContain("scarn tasks retry <taskId>");
  });

  concurrentTest("names several connections once each", () => {
    expect(
      managedConnectionNotReadyError(["Notion", "Acme docs", "Notion"]).message,
    ).toStartWith(
      "The project's Notion and Acme docs connections aren't ready, so the run didn't start; a project admin must reconnect them in project settings.",
    );
  });

  concurrentTest("falls back to generic wording without a label", () => {
    expect(managedConnectionNotReadyError([null, ""]).message).toStartWith(
      "A managed connection this run uses isn't ready, so the run didn't start;",
    );
  });
});
