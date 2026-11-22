import { describe, expect, test } from "bun:test";
import {
  AGENT_MESSAGE_CUT_SUFFIX,
  agentMessageBody,
  MAX_AGENT_MESSAGE_LENGTH,
} from "@/conversations/conversation/domain/agent-message-body";
import { RunSimulator } from "./engine-harness";
import { bugPipeline, bugSteps, clone, type Doc } from "./engine-fixtures";
import { itemsPipeline, itemSteps } from "./engine-fixtures-items";

const evaluation = {
  quality: 0.9,
  hasRumSession: false,
  maxAttempts: 3,
  summary: "crash",
  missingDetails: [],
};
const reproduced = {
  reproductionConfidence: 0.9,
  evidenceVerdict: "reproduced",
};
const plan = { requiresHumanApproval: false, summary: "patch" };
const MESSAGE = "Are exports allowed to run longer than 30 seconds?";

/** The bug pipeline with `propose-fix` running, based on failing-test's branch `t`. */
function atProposeFix(edit: (document: Doc) => void = () => {}) {
  const document = clone(bugPipeline());
  edit(document);
  const run = new RunSimulator(document, bugSteps).start();
  run.succeed("evaluate", evaluation);
  run.succeed("reproduce-from-logs", reproduced, { workBranch: "repro" });
  run.succeed("failing-test", { testPath: "a.test.ts" }, { workBranch: "t" });
  return run;
}

function handedOver() {
  const run = atProposeFix();
  run.yield("propose-fix", MESSAGE, { workBranch: "propose-1" });
  return run;
}

describe("decide: step visits that hand over", () => {
  test.concurrent(
    "a hand-off makes the visit wait; the Task posts the message itself",
    () => {
      const run = atProposeFix();
      const result = run.yield("propose-fix", `  ${MESSAGE}\n`);
      expect(result.ignored).toBeUndefined();
      expect(result.commands.map((command) => command.type)).toEqual([
        "updateVisit",
        "updateRun",
      ]);
      expect(run.open("propose-fix")).toMatchObject({
        status: "waiting",
        routing: null,
      });
      expect(run.state.questions).toEqual([]);
      expect(run.state.run.status).toBe("waiting");
      expect(run.queued()).toEqual([]);
    },
  );

  test.concurrent(
    "a reply resumes the visit on the continuation its Task queued; the engine queues nothing",
    () => {
      const run = handedOver();
      const visit = run.open("propose-fix");
      const result = run.reply("propose-fix");
      expect(result.ignored).toBeUndefined();
      expect(result.commands.map((command) => command.type)).toEqual([
        "updateVisit",
        "updateRun",
      ]);
      expect(run.queued()).toEqual([]);
      expect(run.open("propose-fix")).toMatchObject({
        id: visit.id,
        status: "active",
        result: null,
      });
      expect(run.state.run.status).toBe("active");

      run.succeed("propose-fix", plan, { workBranch: "propose-2" });
      expect(run.trail().slice(-2)).toEqual([
        "propose-fix:succeeded",
        "fix:active",
      ]);
      expect(run.queued()[0]?.baseBranch).toBe("propose-2");
    },
  );

  test.concurrent(
    "task_resumed on a run that isn't the visit's latest is ignored",
    () => {
      const run = handedOver();
      const yielded = run.latestTaskId(run.open("propose-fix").id);
      run.reply("propose-fix");
      run.yield("propose-fix", "again?");
      const late = run.send({ type: "task_resumed", ...run.taskIds(yielded) });
      expect(late.commands).toEqual([]);
      expect(late.ignored?.message).toContain("latest attempt");
    },
  );

  test.concurrent(
    "continuations are more runs of the visit's Task, and a rerun starts a new one",
    () => {
      const run = atProposeFix();
      const taskId = run.queued()[0]?.taskId;
      run.yield("propose-fix", "first?");
      run.reply("propose-fix");
      run.yield("propose-fix", "second?");
      run.reply("propose-fix");
      expect(run.continued?.attemptNumber).toBe(3);
      expect(run.open("propose-fix").taskId).toBe(taskId ?? "");

      run.rerun(run.open("propose-fix").id);
      expect(run.queued()).toMatchObject([
        { attemptNumber: 1, reason: "initial" },
      ]);
      expect(run.queued()[0]?.taskId).not.toBe(taskId);
      expect(run.open("propose-fix").conversationId).toBeNull();
    },
  );

  test.concurrent(
    "a Task that hands over with no turns left fails the visit with Scarn.MaxTurnsExceeded",
    () => {
      const run = atProposeFix((document) => {
        Object.assign(document.nodes["propose-fix"] as object, {
          maxTurns: 1,
          retry: [{ on: ["Scarn.All"], maxAttempts: 3 }],
        });
      });
      run.yield("propose-fix", "first?");
      run.reply("propose-fix");
      const result = run.exceedTurns(
        "propose-fix",
        '"Propose fix" can\'t hand over more than 1 times',
      );
      expect(run.retried).toEqual([]);
      expect(result.commands.map((command) => command.type)).not.toContain(
        "queueTask",
      );
      expect(run.visits("propose-fix")[0]).toMatchObject({
        status: "failed",
        error: {
          name: "Scarn.MaxTurnsExceeded",
          message: '"propose-fix" can\'t hand over more than 1 times',
        },
      });
      expect(run.state.run).toMatchObject({
        status: "failed",
        error: { name: "Scarn.MaxTurnsExceeded" },
      });
    },
  );

  test.concurrent(
    "a catch takes Scarn.MaxTurnsExceeded, without a retry",
    () => {
      const run = atProposeFix((document) => {
        Object.assign(document.nodes["propose-fix"] as object, {
          maxTurns: 0,
          retry: [{ on: ["Scarn.All"], maxAttempts: 3 }],
          catch: [{ on: ["Scarn.MaxTurnsExceeded"], to: "fix-rejected" }],
        });
      });
      run.exceedTurns("propose-fix");
      expect(run.retried).toEqual([]);
      expect(run.queued()).toEqual([]);
      expect(run.trail().slice(-2)).toEqual([
        "propose-fix:failed",
        "fix-rejected:failed",
      ]);
      expect(run.state.run).toMatchObject({
        status: "failed",
        endNodeId: "fix-rejected",
      });
    },
  );

  test.concurrent("a resume of a visit that isn't waiting is ignored", () => {
    const run = atProposeFix();
    const active = run.reply("propose-fix");
    expect(active.commands).toEqual([]);
    expect(active.ignored?.message).toContain("active");
  });

  test.concurrent("question_answered no longer touches step visits", () => {
    const run = handedOver();
    const visit = run.open("propose-fix");
    run.state.questions.push({
      id: "stray",
      visitId: visit.id,
      commentId: "comment",
      status: "open",
      answerCommentId: null,
      answeredByUserId: null,
      createdAt: visit.createdAt,
      resolvedAt: null,
    });
    const result = run.send({
      type: "question_answered",
      questionId: "stray",
      userId: "reporter",
      answer: { commentId: "reply", body: "Yes" },
    });
    expect(result.commands).toEqual([]);
    expect(result.ignored?.message).toContain("isn't a wait");
    expect(run.open("propose-fix").status).toBe("waiting");
  });

  test.concurrent("a stale yield is ignored", () => {
    const run = handedOver();
    const first = run.latestTaskId(run.open("propose-fix").id);
    run.reply("propose-fix");
    const stale = run.yieldTask(first, "again?");
    expect(stale.commands).toEqual([]);
    expect(stale.ignored?.message).toContain("latest attempt");

    run.succeed("propose-fix", plan);
    const latest = run.latestTaskId(run.visits("propose-fix")[0]?.id ?? "");
    const late = run.send({
      type: "task_waiting",
      ...run.taskIds(latest),
      message: "late?",
    });
    expect(late.commands).toEqual([]);
    expect(late.ignored?.message).toContain("succeeded");
  });

  test.concurrent(
    "a late Task event on a waiting step visit is ignored",
    () => {
      const run = handedOver();
      const visit = run.open("propose-fix");
      const ids = run.taskIds(run.latestTaskId(visit.id));
      for (const event of [
        { type: "task_succeeded", ...ids },
        { type: "task_failed", ...ids },
        { type: "task_waiting", ...ids, message: "again?" },
      ] as const) {
        const result = run.send(event);
        expect(result.commands).toEqual([]);
        expect(result.ignored?.message).toContain("waiting");
      }
      expect(run.open("propose-fix").status).toBe("waiting");
    },
  );

  test.concurrent("a rerun while waiting cancels no Task", () => {
    const run = handedOver();
    const visit = run.open("propose-fix");
    const yieldedTaskId = run.latestTaskId(visit.id);
    run.rerun(visit.id, "try the retry approach");
    expect(run.cancelledTasks()).toEqual([]);
    expect(run.visits("propose-fix").map((entry) => entry.status)).toEqual([
      "superseded",
      "active",
    ]);
    expect(run.queued()).toMatchObject([
      { previousTaskId: yieldedTaskId, message: "try the retry approach" },
    ]);
  });

  test.concurrent(
    "a cancel while waiting cancels no Task, and a late reply is ignored",
    () => {
      const run = handedOver();
      const visitId = run.open("propose-fix").id;
      run.send({ type: "cancel", userId: "admin" });
      expect(run.cancelledTasks()).toEqual([]);
      expect(run.visits("propose-fix")[0]?.status).toBe("cancelled");
      expect(run.state.run.status).toBe("cancelled");
      const late = run.send({
        type: "task_resumed",
        ...run.taskIds(run.latestTaskId(visitId)),
      });
      expect(late.commands).toEqual([]);
      expect(late.ignored?.message).toContain("cancelled");
    },
  );

  test.concurrent("yields don't use up retries", () => {
    const run = atProposeFix();
    run.succeed("propose-fix", plan);
    for (const message of ["one?", "two?"]) {
      run.yield("fix", message);
      run.reply("fix");
    }
    run.abandon("fix");
    run.abandon("fix");
    expect(run.retried[0]?.attemptNumber).toBe(5);
    expect(run.open("fix").status).toBe("active");
    run.abandon("fix");
    expect(run.retried).toEqual([]);
    expect(run.visits("fix")[0]).toMatchObject({
      status: "failed",
      error: { name: "Scarn.HeartbeatTimeout" },
    });
  });

  test.concurrent("in a lane, only that lane waits", () => {
    const run = new RunSimulator(clone(itemsPipeline()), itemSteps).start();
    run.succeed(
      "plan-changes",
      { files: ["a.ts", "b.ts"], summary: "rename" },
      { workBranch: "plan" },
    );
    run.yield("edit-file", "Rename the export too?", {
      item: 0,
      workBranch: "edit-0",
    });
    expect(run.open("edit-file", 0).status).toBe("waiting");
    expect(run.open("edit-file", 1).status).toBe("active");
    expect(run.state.run.status).toBe("active");

    run.succeed("edit-file", { path: "b.ts", diff: "+" }, { item: 1 });
    run.succeed("review-edit", { approved: true, confidence: 1 }, { item: 1 });
    expect(run.laneStatuses()).toEqual(["active", "arrived"]);
    expect(run.state.run.status).toBe("waiting");

    run.reply("edit-file", 0);
    expect(run.queued()).toEqual([]);
    expect(run.continued?.attemptNumber).toBe(2);
    expect(run.open("edit-file", 0).status).toBe("active");
    expect(run.state.run.status).toBe("active");
    run.succeed("edit-file", { path: "a.ts", diff: "+" }, { item: 0 });
    run.succeed("review-edit", { approved: true, confidence: 1 }, { item: 0 });
    expect(run.open("approve-reviews").status).toBe("waiting");
  });

  test.concurrent("a long message leaves a cut note on the visit", () => {
    const run = atProposeFix();
    const long = "q".repeat(12_000);
    run.yield("propose-fix", long);
    const { body } = agentMessageBody(long);
    expect(body.length).toBe(MAX_AGENT_MESSAGE_LENGTH);
    expect(body).toEndWith(AGENT_MESSAGE_CUT_SUFFIX);
    expect(body).toEndWith("…(cut to 10,000 characters)");
    expect(run.open("propose-fix").routing).toEqual({
      notes: [{ kind: "question_cut", length: 12_000, limit: 10_000 }],
    });
  });
});
