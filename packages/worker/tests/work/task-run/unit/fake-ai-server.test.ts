import { afterEach, describe, expect, test } from "bun:test";
import {
  buildForcedToolCallPrompt,
  FakeAiServer,
} from "../../../../src/work/task-run/infra/fake-ai/fake-ai-server";
import {
  buildForcedEndConversationPrompt,
  buildForcedEndTurnPrompt,
} from "../../../../src/work/task-run/infra/fake-ai/forced-turn-end-marker";

/**
 * Regression coverage for the concurrency fix `runHealthChecks` (#119/#122)
 * depends on: several checks can now force calls against ONE shared
 * `FakeAiServer` instance at the same time (parallel `serialGroup` lanes —
 * see `run-health-checks.ts`). Before this fix, `FakeAiServer` decided which
 * tool to force purely from `configure()`'s last call — shared, mutable,
 * per-instance state — so a second concurrent `configure()` call could race
 * ahead of the first request that was meant to read it and corrupt which
 * tool a session's forced call actually names. `buildForcedToolCallPrompt`
 * embeds the tool/args directly in the prompt text instead, so each request
 * is self-describing regardless of arrival order — these tests prove that
 * end to end over real HTTP against a real `FakeAiServer`.
 */
describe("FakeAiServer — concurrent forced tool calls", () => {
  let server: FakeAiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function postMessages(
    port: number,
    body: Record<string, unknown>,
  ): Promise<{ content: { type: string; name?: string; input?: unknown }[] }> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: false }),
    });
    return (await response.json()) as {
      content: { type: string; name?: string; input?: unknown }[];
    };
  }

  function toolUsePart(response: {
    content: { type: string; name?: string; input?: unknown }[];
  }) {
    return response.content.find((block) => block.type === "tool_use");
  }

  test("a request whose prompt was built by buildForcedToolCallPrompt forces that tool/args, even when configure() was called for something else", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();

    // Simulates the exact race the fix closes: `configure()` was last called
    // for a completely different tool (as another concurrent check would
    // have done), but this request's own prompt names its own tool.
    server.configure("wrong-tool-from-another-check", { wrong: true });

    const response = await postMessages(port, {
      messages: [
        {
          role: "user",
          content: buildForcedToolCallPrompt("real_tool", { the: "args" }),
        },
      ],
    });

    const toolUse = toolUsePart(response);
    expect(toolUse?.name).toBe("real_tool");
    expect(toolUse?.input).toEqual({ the: "args" });
  });

  test("two concurrent requests built with buildForcedToolCallPrompt each get their own tool, never the other's", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();

    const [responseA, responseB] = await Promise.all([
      postMessages(port, {
        messages: [
          {
            role: "user",
            content: buildForcedToolCallPrompt("tool_a", { id: "a" }),
          },
        ],
      }),
      postMessages(port, {
        messages: [
          {
            role: "user",
            content: buildForcedToolCallPrompt("tool_b", { id: "b" }),
          },
        ],
      }),
    ]);

    expect(toolUsePart(responseA)?.name).toBe("tool_a");
    expect(toolUsePart(responseA)?.input).toEqual({ id: "a" });
    expect(toolUsePart(responseB)?.name).toBe("tool_b");
    expect(toolUsePart(responseB)?.input).toEqual({ id: "b" });
  });

  test("falls back to configure() when the prompt has no marker (the non-health-check, non-concurrent caller)", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();
    server.configure("scarn-submit-step-findings", { ok: true });

    const response = await postMessages(port, {
      messages: [{ role: "user", content: "Please do the assigned task." }],
    });

    const toolUse = toolUsePart(response);
    expect(toolUse?.name).toBe("scarn-submit-step-findings");
    expect(toolUse?.input).toEqual({ ok: true });
  });
});

describe("FakeAiServer — final text", () => {
  let server: FakeAiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  type Block = { type: string; text?: string; name?: string };

  async function postMessages(
    port: number,
    messages: unknown[],
  ): Promise<{ content: Block[] }> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, stream: false }),
    });
    return (await response.json()) as { content: Block[] };
  }

  const toolResultTurn = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
  };

  function textOf(response: { content: Block[] }): string | undefined {
    return response.content.find((block) => block.type === "text")?.text;
  }

  test("ends the turn with the default text when nothing sets one", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();

    const response = await postMessages(port, [
      { role: "user", content: "Do the task." },
      toolResultTurn,
    ]);

    expect(textOf(response)).toBe("Fake ai response.");
  });

  test("configure() with finalText changes the end-turn text", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();
    server.configure("some-tool", {}, { finalText: "Which env?" });

    const response = await postMessages(port, [
      { role: "user", content: "Do the task." },
      toolResultTurn,
    ]);

    expect(textOf(response)).toBe("Which env?");
  });

  test("an end-turn prompt ends the first request with its text and calls no tool", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();
    server.configure("scarn-submit-step-findings", { findingsJson: {} });

    const response = await postMessages(port, [
      {
        role: "user",
        content: `Do the task. ${buildForcedEndTurnPrompt("Should I drop the column?")}`,
      },
    ]);

    expect(response.content.some((b) => b.type === "tool_use")).toBe(false);
    expect(textOf(response)).toBe("Should I drop the column?");
  });

  test("an end-conversation prompt forces scarn-end-conversation, then ends with its final text", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();
    const prompt = {
      role: "user",
      content: buildForcedEndConversationPrompt("Thanks, all done."),
    };

    const first = await postMessages(port, [prompt]);
    const second = await postMessages(port, [prompt, toolResultTurn]);

    expect(first.content.find((b) => b.type === "tool_use")?.name).toBe(
      "scarn-end-conversation",
    );
    expect(textOf(second)).toBe("Thanks, all done.");
  });

  test("a restored session's new user message starts a new turn that forces the tool again", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();
    server.configure("scarn-submit-step-findings", { findingsJson: {} });
    const restoredHistory = [
      {
        role: "user",
        content: buildForcedEndTurnPrompt("Should I drop the column?"),
      },
      { role: "assistant", content: "Should I drop the column?" },
      { role: "user", content: "Reply from Sam: keep it." },
    ];

    const resumed = await postMessages(port, restoredHistory);
    const finished = await postMessages(port, [
      ...restoredHistory,
      toolResultTurn,
    ]);

    expect(resumed.content.find((b) => b.type === "tool_use")?.name).toBe(
      "scarn-submit-step-findings",
    );
    expect(textOf(finished)).toBe("Fake ai response.");
  });

  test("records each request's messages", async () => {
    server = new FakeAiServer({ initialToolUseDelayMs: 0 });
    const port = await server.start();
    await postMessages(port, [{ role: "user", content: "Do the task." }]);

    expect(server.requests).toEqual([
      { messages: [{ role: "user", content: "Do the task." }] },
    ]);
  });
});
