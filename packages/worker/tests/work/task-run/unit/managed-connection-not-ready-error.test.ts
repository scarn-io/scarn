import { describe, expect, test } from "bun:test";
import { ManagedConnectionNotReadyError } from "../../../../src/work/task-run/application/managed-connection-not-ready-error";

describe("ManagedConnectionNotReadyError", () => {
  test("names the connection by the label the server sent", () => {
    expect(
      new ManagedConnectionNotReadyError({
        key: "docs",
        connection: "acme-docs",
        label: "Acme docs",
      }).message,
    ).toStartWith(
      "The project's Acme docs connection isn't ready, so the run didn't start; a project admin must reconnect it in project settings.",
    );
  });

  test("names it by the connection name when the project has no such connection", () => {
    expect(
      new ManagedConnectionNotReadyError({
        key: "docs",
        connection: "acme-docs",
        label: null,
      }).message,
    ).toStartWith(
      "The project's \"acme-docs\" connection isn't ready or doesn't exist, so the run didn't start; a project admin must connect it in project settings.",
    );
  });

  test("falls back to generic wording without meta", () => {
    const message = new ManagedConnectionNotReadyError().message;
    expect(message).toStartWith(
      "A managed connection this run uses isn't ready, so the run didn't start;",
    );
    expect(message).toContain("scarn tasks retry <taskId>");
  });
});
