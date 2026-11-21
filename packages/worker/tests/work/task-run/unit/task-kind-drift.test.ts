/**
 * The worker does not depend on `@scarn/core`, so its `TaskKind` union and
 * `TaskToolCall` shape cannot be derived from the server's. The SDK's
 * generated API types are produced from the server's worker-context schema,
 * so pinning the worker types to them fails typecheck if either side drifts.
 */
import { describe, expect, test } from "bun:test";
import type { PostApiTaskRunsByTaskRunIdWorkerContextResponses } from "@scarn/sdk";
import type {
  TaskKind,
  TaskRunWorkerContextContract,
} from "../../../../src/work/task-run/contracts/task-run-contracts";

type ServerTask = PostApiTaskRunsByTaskRunIdWorkerContextResponses[200]["task"];

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const kindsMatch: MutuallyAssignable<TaskKind, ServerTask["kind"]> = true;
const mcpToolIsAKind: MutuallyAssignable<
  Extract<TaskKind, "mcp_tool">,
  "mcp_tool"
> = true;
const toolCallsMatch: MutuallyAssignable<
  TaskRunWorkerContextContract["task"]["toolCall"],
  ServerTask["toolCall"]
> = true;

describe("TaskKind", () => {
  test("matches the server's task kinds", () => {
    expect(kindsMatch).toBe(true);
    expect(mcpToolIsAKind).toBe(true);
  });

  test("the worker context's toolCall matches the server's", () => {
    expect(toolCallsMatch).toBe(true);
  });
});
