import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type {
  WorkItemActionClient,
  WorkItemComment,
  WorkItemQuestion,
} from "@scarn/shared-core";
import { createWorkItemsCommand } from "../src/commands/work-items";
import type { CliError } from "../src/lib/cli-error";
import {
  fail,
  fakeIo,
  ok,
  rejection,
  runAction,
  unusedReads,
  type FakeIo,
} from "./action-harness";

setDefaultTimeout(15_000);

const WORK_ITEM_ID = "0196a000-0000-7000-8000-0000000000aa";
const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const RUN_ID = "0196a000-0000-7000-8000-0000000000bb";
const REF = "acme/app#7";

const comment = (id: string, body: string): WorkItemComment => ({
  id,
  authorKind: "user",
  authorName: null,
  authorUsername: "ada",
  authoredByTaskId: null,
  parentCommentId: null,
  externalCommentUrl: null,
  body,
  isPinned: false,
  createdAt: "2026-01-02T00:00:00.000Z",
});

const question = (
  questionId: string,
  status: WorkItemQuestion["status"],
): WorkItemQuestion => ({
  questionId,
  status,
  pipelineExecutionId: RUN_ID,
  body: "Which database?",
  askedAt: "2026-01-01T00:00:00.000Z",
  waitingOn: [],
});

type Calls = { refs: string[]; comments: unknown[]; answers: unknown[] };

function setup(
  io: FakeIo,
  overrides: { answer?: WorkItemActionClient["pipelineExecutions"] } = {},
) {
  const calls: Calls = { refs: [], comments: [], answers: [] };
  const client: WorkItemActionClient = {
    workItemComments: {
      createWorkItemComment: ({ body }) => {
        calls.comments.push(body);
        return ok(comment("c-1", body.body));
      },
    },
    workItems: {
      listWorkItemQuestions: () =>
        ok([question("q-open", "open"), question("q-done", "answered")]),
    },
    pipelineExecutions: overrides.answer ?? {
      answerQuestion: ({ path, body }) => {
        calls.answers.push({ path, body });
        return ok(comment("c-2", body.body));
      },
    },
  };
  const command = createWorkItemsCommand(unusedReads, {
    connect: () =>
      Promise.resolve({ client, headers: { Authorization: "Bearer t" } }),
    resolveRef: (ref) => {
      calls.refs.push(ref);
      return Promise.resolve({
        workItemId: WORK_ITEM_ID,
        projectId: PROJECT_ID,
      });
    },
    io,
  });
  return {
    calls,
    run: (args: readonly string[]) =>
      runAction(command, ["work-items", ...args]),
  };
}

describe("scarn work-items comment", () => {
  test("resolves the ref, posts the body and hints at comments", async () => {
    const io = fakeIo();
    const { calls, run } = setup(io);

    const stdout = await run(["comment", REF, "--body", "Looks good."]);

    expect(io.asked).toEqual([]);
    expect(calls.refs).toEqual([REF]);
    expect(calls.comments).toEqual([
      { workItemId: WORK_ITEM_ID, body: "Looks good." },
    ]);
    expect(stdout).toContain(`Added comment c-1 to work item ${WORK_ITEM_ID}.`);
    expect(stdout).toContain(`→ scarn work-items comments ${REF}`);
  });

  test("an empty --body is invalid_usage", async () => {
    const { calls, run } = setup(fakeIo({ stdin: "  \n" }));

    const error = await rejection(run(["comment", REF, "--body", "-"]));

    expect((error as CliError).code).toBe("invalid_usage");
    expect(calls.comments).toEqual([]);
  });
});

describe("scarn work-items answer", () => {
  test("answers through the question's pipeline run", async () => {
    const { calls, run } = setup(
      fakeIo({ files: { "answer.md": "Postgres.\n" } }),
    );

    const stdout = await run([
      "answer",
      REF,
      "q-open",
      "--body",
      "@answer.md",
      "--json",
    ]);

    expect(calls.answers).toEqual([
      {
        path: { pipelineExecutionId: RUN_ID, questionId: "q-open" },
        body: { body: "Postgres." },
      },
    ]);
    expect((JSON.parse(stdout) as { id: string }).id).toBe("c-2");
  });

  test("an unknown question is action_not_found listing the open ones", async () => {
    const { run } = setup(fakeIo());

    const error = await rejection(
      run(["answer", REF, "q-nope", "--body", "hi"]),
    );

    expect((error as CliError).code).toBe("action_not_found");
    expect(error.message).toContain("Open questions: q-open.");
  });

  test("an answered question is action_conflict, without calling the API", async () => {
    const { calls, run } = setup(fakeIo());

    const error = await rejection(
      run(["answer", REF, "q-done", "--body", "hi"]),
    );

    expect((error as CliError).code).toBe("action_conflict");
    expect(calls.answers).toEqual([]);
  });

  test("a 403 from the API is action_forbidden", async () => {
    const { run } = setup(fakeIo(), {
      answer: { answerQuestion: () => fail(403, "Missing comments:create.") },
    });

    const error = await rejection(
      run(["answer", REF, "q-open", "--body", "hi"]),
    );

    expect((error as CliError).code).toBe("action_forbidden");
    expect(error.message).toBe(
      "Could not answer question q-open: Missing comments:create.",
    );
  });
});
