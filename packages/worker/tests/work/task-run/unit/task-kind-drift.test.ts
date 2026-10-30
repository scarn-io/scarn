/**
 * The worker does not depend on `@scarn/core`, so its `TaskKind` union
 * cannot be derived from the server's task kinds. The SDK's generated API
 * types are produced from the server's worker-context schema, so pinning the
 * worker union to them fails typecheck if either side drifts.
 */
import { describe, expect, test } from "bun:test";
import type { PostApiTaskRunsByTaskRunIdWorkerContextResponses } from "@scarn/sdk";
import type { TaskKind } from "../../../../src/work/task-run/contracts/task-run-contracts";

type ServerTaskKind =
  PostApiTaskRunsByTaskRunIdWorkerContextResponses[200]["task"]["kind"];

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const kindsMatch: MutuallyAssignable<TaskKind, ServerTaskKind> = true;

describe("TaskKind", () => {
  test("matches the server's task kinds", () => {
    expect(kindsMatch).toBe(true);
  });
});
