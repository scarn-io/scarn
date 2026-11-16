import { describe, expect, test } from "bun:test";
import {
  DEVCONTAINER_NOTICE_MESSAGE,
  DEVCONTAINER_PRESENT_LABEL,
  DEVCONTAINER_MISSING_LABEL,
  DEVCONTAINER_TASK_LABEL,
  reportDevcontainerStatus,
} from "../src/lib/init-devcontainer-notice";
import {
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
  reportedMethods as methods,
} from "./utils";

/**
 * The devcontainer step of `scarn init`.
 *
 * Missing optional configuration must remain a notice, not a hard stop, and
 * explain the managed runtime default without promising a design-session
 * configuration change.
 */

describe("reportDevcontainerStatus", () => {
  test("reports a present devcontainer as a resolved task", async () => {
    const { reporter, calls, tasks } = createRecorder();

    const result = await reportDevcontainerStatus({
      reporter,
      ports: { hasDevcontainer: () => Promise.resolve(true) },
    });

    expect(result).toEqual({ present: true });
    expect(tasks[0]?.message).toBe(DEVCONTAINER_TASK_LABEL);
    expect(methods(tasks)).toEqual(["startActivity", "succeed"]);
    expect(tasks[1]?.message).toBe(DEVCONTAINER_PRESENT_LABEL);
    // Nothing to caution about when one already exists.
    expect(methods(calls)).not.toContain("warn");
  });

  test("a missing devcontainer resolves the task and warns", async () => {
    const { reporter, calls, tasks } = createRecorder();

    const result = await reportDevcontainerStatus({
      reporter,
      ports: { hasDevcontainer: () => Promise.resolve(false) },
    });

    expect(result).toEqual({ present: false });
    // `succeed`, never `fail`: init did its job: it looked, and it is telling
    // the user what it found. A failed task reads like a blocked install.
    expect(methods(tasks)).toEqual(["startActivity", "succeed"]);
    expect(tasks[1]?.message).toBe(DEVCONTAINER_MISSING_LABEL);
    expect(messages(calls)).toContain(DEVCONTAINER_NOTICE_MESSAGE);
  });

  test("never throws when the devcontainer is missing", async () => {
    const { reporter } = createRecorder();

    let threw = false;
    try {
      await reportDevcontainerStatus({
        reporter,
        ports: { hasDevcontainer: () => Promise.resolve(false) },
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  test("the notice explains the managed default and optional devcontainer configuration", () => {
    expect(DEVCONTAINER_NOTICE_MESSAGE).toContain(
      "managed `bun1` runtime by default",
    );
    expect(DEVCONTAINER_NOTICE_MESSAGE).toContain("No action is required");
    expect(DEVCONTAINER_NOTICE_MESSAGE).toContain("optionally add");
    expect(DEVCONTAINER_NOTICE_MESSAGE).toContain(
      ".devcontainer/devcontainer.json",
    );
    expect(DEVCONTAINER_NOTICE_MESSAGE).not.toContain("pipelines design");
    expect(DEVCONTAINER_NOTICE_MESSAGE).not.toContain("runs every step");
    expect(DEVCONTAINER_NOTICE_MESSAGE).not.toMatch(/re-run `scarn init`/u);
  });

  test("surfaces a failed check rather than swallowing it", async () => {
    // A missing devcontainer is a notice; an unreadable filesystem is not, and
    // must not be reported as "no devcontainer".
    const { reporter, tasks } = createRecorder();
    const boom = new Error("EIO");

    let caught: Error | null = null;
    try {
      await reportDevcontainerStatus({
        reporter,
        ports: { hasDevcontainer: () => Promise.reject(boom) },
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBe(boom);
    expect(methods(tasks)).toEqual(["startActivity", "fail"]);
  });
});
