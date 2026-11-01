/**
 * Conversation steps: a `defineStep` with no `result` publishes with a null
 * result schema, and its result is `{ conversationId, summary }`.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CONVERSATION_RESULT_SCHEMA } from "@scarn/sdk/contracts/pipeline-document";
import { codeStep, defineStep } from "@scarn/sdk/definitions/steps";
import { definePipeline, succeed } from "@scarn/sdk/pipelines";

const grill = defineStep({
  key: "grill",
  name: "Grill",
  agentPrompt: "Grill the person about the design.",
});

const write = defineStep({
  key: "write",
  name: "Write",
  agentPrompt: "Write it up.",
  input: z.object({ summary: z.string() }),
  result: z.object({ path: z.string() }),
});

const shout = codeStep({
  key: "shout",
  name: "Shout",
  fn: () => ({}),
});

const done = succeed("done");

describe("conversation steps", () => {
  test("a conversation step's catalog entry has a null result schema, and maxTurns compiles into its node a null result ", () => {
    const pipeline = definePipeline({
      key: "grill",
      start: grill(),
      flow: [
        grill
          .settings({ maxTurns: 3 })
          .next((r) => write({ summary: r.result.summary })),
        write.next(shout()),
        shout.next(done),
      ],
    });
    expect(pipeline.steps["grill"]?.resultSchema).toBeNull();
    expect(pipeline.steps["write"]?.resultSchema).not.toBeNull();
    expect(pipeline.steps["shout"]?.resultSchema).not.toBeNull();
    expect(pipeline.document.nodes["grill"]).toMatchObject({
      kind: "step",
      step: "grill",
      maxTurns: 3,
      next: {
        routes: [{ to: "write", args: { summary: "result.summary" } }],
      },
    });
    expect(CONVERSATION_RESULT_SCHEMA).toMatchObject({
      required: ["conversationId", "summary"],
    });
  });
});
