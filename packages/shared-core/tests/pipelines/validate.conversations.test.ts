import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_RESULT_SCHEMA,
  type StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import { obj } from "./fixture-schema";
import { errorsOf, expectError } from "./helpers";

const steps: StepCatalog = {
  grill: { inputSchema: obj("GrillInput", {}), resultSchema: null, errors: [] },
  write: {
    inputSchema: obj("WriteInput", {
      conversationId: { type: "string" },
      summary: { type: "string" },
    }),
    resultSchema: obj("WriteResult", {}),
    errors: [],
  },
};

/** A conversation step (`grill`) whose transitions are `next`. */
function grillPipeline(grill: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    key: "grill",
    start: { to: "grill" },
    nodes: {
      grill: {
        kind: "step",
        step: "grill",
        next: {
          routes: [
            {
              to: "write",
              args: {
                conversationId: "result.conversationId",
                summary: "result.summary",
              },
            },
          ],
        },
        ...grill,
      },
      write: {
        kind: "step",
        step: "write",
        next: {
          routes: [{ to: "done" }],
        },
      },
      done: { kind: "succeed" },
    },
  };
}

describe("conversation steps", () => {
  test.concurrent(
    "a null result schema types result as { conversationId, summary }",
    () => {
      expect(CONVERSATION_RESULT_SCHEMA).toMatchObject({
        required: ["conversationId", "summary"],
      });
      expect(errorsOf(grillPipeline(), steps)).toEqual([]);
    },
  );

  test.concurrent("a transition reading result.decision is rejected", () => {
    const document = grillPipeline({
      next: {
        routes: [
          {
            when: { path: "result.decision", op: "equal", value: "SAML" },
            to: "done",
          },
        ],
        otherwise: {
          to: "write",
          args: {
            conversationId: "result.conversationId",
            summary: "result.summary",
          },
        },
      },
    });
    expectError(errorsOf(document, steps), {
      code: "unknown_path",
      path: "/nodes/grill/next/routes/0/when/path",
    });
  });

  test.concurrent("maxTurns: 0 is rejected", () => {
    expect(errorsOf(grillPipeline({ maxTurns: 0 }), steps)).toEqual([
      {
        code: "conversation_needs_turns",
        path: "/nodes/grill/maxTurns",
        message:
          '"grill" is a conversation step with "maxTurns" 0, so it could never hand the conversation to a person',
        hint: 'Raise "maxTurns", or give the step a result schema',
      },
    ]);
    expect(errorsOf(grillPipeline({ maxTurns: 1 }), steps)).toEqual([]);
  });

  test.concurrent("maxTurns: 0 is fine on a step with a result schema", () => {
    const document = grillPipeline();
    (document.nodes.write as Record<string, unknown>)["maxTurns"] = 0;
    expect(errorsOf(document, steps)).toEqual([]);
  });
});
