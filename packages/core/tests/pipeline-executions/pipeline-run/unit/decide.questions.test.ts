import { describe, expect, test } from "bun:test";
import {
  DEFAULT_QUESTION,
  MAX_QUESTION_LENGTH,
} from "@/pipeline-executions/pipeline-run/domain/engine/questions";
import { RunSimulator } from "./engine-harness";
import { bugPipeline, bugSteps, clone } from "./engine-fixtures";
import { itemsPipeline, itemSteps } from "./engine-fixtures-items";

const evaluation = {
  quality: 0.9,
  hasRumSession: false,
  maxAttempts: 3,
  summary: "crash",
  missingDetails: [],
};
const vague = {
  ...evaluation,
  quality: 0.01,
  missingDetails: ["Which browser?", "When did it start?"],
};
const PREAMBLE = "Before I can go on, could you answer:";

function waitingForDetails() {
  const run = new RunSimulator(bugPipeline(), bugSteps).start();
  run.succeed("evaluate", vague);
  return run;
}

describe("decide: reply waits", () => {
  test.concurrent("entering a reply wait creates the visit, then asks", () => {
    const run = waitingForDetails();
    const types = run.last.commands.map((command) => command.type);
    const created = types.lastIndexOf("createVisit");
    expect(created).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("askQuestion")).toBe(created + 1);
    const visit = run.open("ask-for-details");
    expect(visit).toMatchObject({
      status: "waiting",
      input: { questions: vague.missingDetails },
    });
    expect(run.asked()).toEqual([
      {
        type: "askQuestion",
        questionId: "id-5",
        commentId: "id-6",
        visitId: visit.id,
        body: `${PREAMBLE}\n\n- Which browser?\n- When did it start?`,
      },
    ]);
    expect(run.questions("ask-for-details")).toMatchObject([
      { id: "id-5", commentId: "id-6", status: "open" },
    ]);
    expect(run.state.run.status).toBe("waiting");
  });

  test.concurrent("an answer resolves the wait and loops to evaluate", () => {
    const run = waitingForDetails();
    const question = run.openQuestion("ask-for-details");
    const result = run.answer(question.id, "Chrome, since Monday");
    expect(result.commands.map((command) => command.type).slice(0, 2)).toEqual([
      "updateQuestion",
      "updateVisit",
    ]);
    expect(run.questions("ask-for-details")[0]).toMatchObject({
      status: "answered",
      answerCommentId: `answer-${question.id}`,
      answeredByUserId: "reporter",
    });
    expect(run.visits("ask-for-details")[0]).toMatchObject({
      status: "succeeded",
      result: {
        replied: true,
        body: "Chrome, since Monday",
        commentId: `answer-${question.id}`,
      },
      resolvedByUserId: "reporter",
    });
    expect(run.trail()).toEqual([
      "evaluate:succeeded",
      "ask-for-details:succeeded",
      "evaluate:active",
    ]);
    expect(run.open("evaluate").input).toEqual({
      companyNames: "Acme",
      employeeEmails: "ana@example.com",
    });
    expect(run.state.run.status).toBe("active");
  });

  test.concurrent("continue without reply resolves with replied false", () => {
    const run = waitingForDetails();
    const question = run.openQuestion("ask-for-details");
    run.answer(question.id, null);
    expect(run.questions("ask-for-details")[0]).toMatchObject({
      status: "answered",
      answerCommentId: null,
      answeredByUserId: "reporter",
    });
    expect(run.visits("ask-for-details")[0]?.result).toEqual({
      replied: false,
      body: null,
      commentId: null,
    });
    expect(run.open("evaluate").status).toBe("active");
  });

  test.concurrent("an answer to a question that isn't open is ignored", () => {
    const run = waitingForDetails();
    const question = run.openQuestion("ask-for-details");
    run.answer(question.id, "first");
    const again = run.answer(question.id, "second");
    expect(again.commands).toEqual([]);
    expect(again.ignored?.message).toContain("answered");
    const unknown = run.answer("nope", "hello");
    expect(unknown.commands).toEqual([]);
    expect(unknown.ignored?.message).toContain("nope");
  });

  test.concurrent(
    "a decision on a reply wait is ignored and leaves the question open",
    () => {
      const run = waitingForDetails();
      const result = run.decide("ask-for-details", "approve");
      expect(result.commands).toEqual([]);
      expect(result.ignored?.kind).toBe("not_waiting");
      expect(run.open("ask-for-details").status).toBe("waiting");
      expect(run.openQuestion("ask-for-details").status).toBe("open");
    },
  );

  test.concurrent("a rerun upstream marks the open question not needed", () => {
    const run = waitingForDetails();
    run.rerun(run.visits("evaluate")[0]?.id as string);
    expect(run.questions("ask-for-details")).toMatchObject([
      { status: "not_needed" },
    ]);
    expect(run.questions("ask-for-details")[0]?.resolvedAt).not.toBeNull();
    expect(run.trail()).toEqual([
      "evaluate:superseded",
      "ask-for-details:superseded",
      "evaluate:active",
    ]);
  });

  test.concurrent("cancel marks the open question not needed", () => {
    const run = waitingForDetails();
    run.send({ type: "cancel", userId: "admin" });
    expect(run.questions("ask-for-details")).toMatchObject([
      { status: "not_needed" },
    ]);
    expect(run.trail()).toEqual([
      "evaluate:succeeded",
      "ask-for-details:cancelled",
    ]);
  });

  test.concurrent(
    "another lane failing marks a lane's open question not needed",
    () => {
      const document = clone(itemsPipeline());
      document.nodes["edit-file"] = {
        kind: "step",
        step: "edit-file",
        next: {
          routes: [
            {
              to: "ask-reviewer",
              args: { questions: { value: ["Looks ok?"] } },
            },
          ],
        },
      };
      document.nodes["ask-reviewer"] = {
        kind: "wait",
        for: "reply",
        next: {
          routes: [
            {
              to: "review-edit",
              args: {
                path: "nodes.edit-file.result.path",
                diff: "nodes.edit-file.result.diff",
              },
            },
          ],
        },
      };
      const run = new RunSimulator(document, itemSteps).start();
      run.succeed("plan-changes", { files: ["a", "b"], summary: "s" });
      run.succeed("edit-file", { path: "pa", diff: "+" }, { item: 0 });
      expect(run.openQuestion("ask-reviewer").status).toBe("open");
      run.fail("edit-file", { item: 1 });
      expect(run.questions("ask-reviewer")).toMatchObject([
        { status: "not_needed" },
      ]);
      expect(run.visits("ask-reviewer")[0]?.status).toBe("cancelled");
      expect(run.state.run.status).toBe("failed");
    },
  );

  test.concurrent("a rerun of the reply wait posts a new question", () => {
    const run = waitingForDetails();
    const first = run.openQuestion("ask-for-details");
    run.rerun(run.open("ask-for-details").id);
    expect(run.asked()).toHaveLength(1);
    expect(run.questions("ask-for-details")).toMatchObject([
      { id: first.id, status: "not_needed" },
      { status: "open" },
    ]);
    expect(run.openQuestion("ask-for-details").id).not.toBe(first.id);
    expect(run.open("ask-for-details").input).toEqual({
      questions: vague.missingDetails,
    });
  });

  test.concurrent(
    "the third entry fails with MaxRunsExceeded, asks nothing and goes to insufficient-detail",
    () => {
      const run = waitingForDetails();
      run.answer(run.openQuestion("ask-for-details").id, "a");
      run.succeed("evaluate", vague);
      run.answer(run.openQuestion("ask-for-details").id, "b");
      run.succeed("evaluate", vague);
      expect(run.asked()).toEqual([]);
      const third = run.visits("ask-for-details").at(-1);
      expect(third).toMatchObject({
        status: "failed",
        error: { name: "Scarn.MaxRunsExceeded" },
      });
      expect(
        run.state.questions.map((question) => question.visitId),
      ).not.toContain(third?.id);
      expect(run.visits("insufficient-detail")[0]?.transition).toEqual({
        kind: "catch",
        index: 0,
      });
      expect(run.state.run).toMatchObject({
        status: "failed",
        endNodeId: "insufficient-detail",
        error: { name: "InsufficientDetail" },
      });
    },
  );

  test.concurrent("a rerun resets the reply wait's run count", () => {
    const run = waitingForDetails();
    run.answer(run.openQuestion("ask-for-details").id, "a");
    run.succeed("evaluate", vague);
    run.answer(run.openQuestion("ask-for-details").id, "b");
    run.succeed("evaluate", vague);
    expect(run.state.run.status).toBe("failed");
    run.rerun(run.visits("evaluate")[0]?.id as string);
    run.succeed("evaluate", vague);
    expect(run.asked()).toHaveLength(1);
    expect(run.open("ask-for-details").status).toBe("waiting");
    expect(run.state.run.status).toBe("waiting");
  });

  test.concurrent(
    "a questions arg that resolves to nothing asks the default question",
    () => {
      const run = new RunSimulator(bugPipeline(), bugSteps).start();
      run.succeed("evaluate", {
        quality: vague.quality,
        hasRumSession: vague.hasRumSession,
        maxAttempts: vague.maxAttempts,
        summary: vague.summary,
      });
      expect(run.open("ask-for-details").input).toEqual({});
      expect(run.asked()[0]?.body).toBe(`${PREAMBLE}\n\n- ${DEFAULT_QUESTION}`);
    },
  );
});

describe("decide: reply wait question limits", () => {
  const many = Array.from({ length: 12 }, (_, index) => `Q${String(index)}?`);
  const long = "x".repeat(MAX_QUESTION_LENGTH + 100);

  test.concurrent.each([
    ["no questions", [], [DEFAULT_QUESTION], undefined],
    ["only blank questions", ["", "   "], [DEFAULT_QUESTION], undefined],
    [
      "untrimmed questions",
      ["  Which browser?  ", ""],
      ["Which browser?"],
      undefined,
    ],
    ["a long question", [long], ["x".repeat(MAX_QUESTION_LENGTH)], undefined],
    [
      "more than ten questions",
      many,
      many.slice(0, 10),
      { kind: "questions_dropped", asked: 10, dropped: 2 },
    ],
  ] as const)("%s", (_name, questions, expected, note) => {
    const run = new RunSimulator(bugPipeline(), bugSteps).start();
    run.succeed("evaluate", { ...vague, missingDetails: [...questions] });
    expect(run.asked()[0]?.body).toBe(
      [PREAMBLE, "", ...expected.map((question) => `- ${question}`)].join("\n"),
    );
    const notes = run.open("ask-for-details").routing?.notes ?? [];
    expect(notes).toEqual(note === undefined ? [] : [note]);
  });
});
