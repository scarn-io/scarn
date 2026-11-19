import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type pino from "pino";
import { formatLogLine } from "../../src/logging/console";

describe("formatLogLine", () => {
  test("censors the same secret paths as createLogger", () => {
    const line = formatLogLine({
      level: 30,
      body: { name: "Work Jira", value: "secret-token-1" },
      req: { body: { email: "me@example.com", apiKey: "secret-token-2" } },
      jiraCredential: { apiKey: "secret-token-3" },
      msg: "request",
    });

    expect(line).not.toContain("secret-token");
    expect(JSON.parse(line)).toMatchObject({
      body: { name: "Work Jira", value: "[REDACTED]" },
      req: { body: { email: "me@example.com", apiKey: "[REDACTED]" } },
      jiraCredential: { apiKey: "[REDACTED]" },
      msg: "request",
    });
  });

  test("serializes errors with their message and stack", () => {
    const parsed = JSON.parse(formatLogLine({ err: new Error("boom") })) as {
      err: { type: string; message: string; stack: string };
    };

    expect(parsed.err.type).toBe("Error");
    expect(parsed.err.message).toBe("boom");
    expect(parsed.err.stack).toContain("boom");
  });

  test("does not mutate the logged object", () => {
    const body = { value: "secret-token-4" };
    formatLogLine({ body });

    expect(body.value).toBe("secret-token-4");
  });
});

describe("createConsoleLogger", () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("writes redacted JSON lines to console by level", async () => {
    // Bun resolves pino to its Node build; the Worker bundle uses the browser
    // build, which is the one honouring `browser.write`. Load that one here.
    // @ts-expect-error -- pino ships no declarations for its browser entry.
    const pinoBrowser = (await import("pino/browser.js")) as {
      default: typeof pino;
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    spies.push(log, error);

    const { createConsoleLoggerWith } = await import(
      "../../src/logging/console"
    );
    const logger = createConsoleLoggerWith(pinoBrowser.default, {
      name: "api",
    });
    logger.info({ body: { token: "secret-token-5" } }, "hello");
    logger.error({ err: new Error("bad") }, "failed");

    const infoLine = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(infoLine).toMatchObject({
      name: "api",
      level: 30,
      msg: "hello",
      body: { token: "[REDACTED]" },
    });
    const errorLine = JSON.parse(String(error.mock.calls[0]?.[0])) as {
      level: number;
      err: { message: string };
    };
    expect(errorLine.level).toBe(50);
    expect(errorLine.err.message).toBe("bad");
  });
});
