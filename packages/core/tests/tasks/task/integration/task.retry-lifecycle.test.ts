import { describe, expect } from "bun:test";
import {
  concurrentTest,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { systemTimeProvider } from "@/lib/time-provider";
import { createHandOverHarness } from "./hand-over-test-support";

describe("manual retry worker lifecycle", () => {
  const h = createHandOverHarness({
    timeProvider: systemTimeProvider,
    objectStore: null,
  });

  concurrentTest(
    "preserves instructions, config and failed logs; a new worker can succeed",
    async () => {
      const { projectId, headers } = h.requireSetup();
      const key = `retry_snapshot_${crypto.randomUUID()}`;
      const definition = {
        projectId,
        key,
        name: "Original instructions",
        description: "Retry snapshot",
        version: 1,
        kind: "user_defined" as const,
        prompt: "Use the original prompt.",
        inputSchemaJson: { type: "object" },
        resultSchemaJson: { type: "object" },
        status: "active" as const,
        repo: { mode: "readOnly" as const },
        environment: {
          kind: "inline" as const,
          envJson: [
            {
              name: "RETRY_CONFIG",
              source: "value" as const,
              value: "original",
              secret: false,
              applies: "agent" as const,
            },
          ],
        },
      };
      const step = await unwrapAsync(
        h.apiClient.api["step-definitions"].post(definition, { headers }),
      );
      const workItemId = await h.seedItem();
      const created = await unwrapStartedTaskAsync(
        h.apiClient.api.tasks.post(
          {
            projectId,
            workItemId,
            stepDefinitionId: step.id,
            stepDefinitionVersion: 1,
            inputJson: { ticket: "original" },
          },
          { headers },
        ),
      );
      const oldId = created.run.id;
      const oldToken = await h.claim(workItemId, oldId);
      const originalContext = await h.workerContext(oldId, oldToken);
      const routes = h.apiClient.api["task-runs"]({ taskRunId: oldId });
      await unwrapAsync(
        routes.logs.post(
          {
            claimToken: oldToken,
            lines: [
              {
                seq: 1,
                stream: "worker",
                ts: "2026-01-01T12:00:00.000Z",
                content: "Original attempt failed",
                level: "error",
              },
            ],
          },
          { headers },
        ),
      );
      const failure = { name: "Scarn.StepFailed", message: "original failure" };
      await h.completeRun(oldId, oldToken, {
        status: "failed",
        errorJson: failure,
      });
      const endpoint = h.apiClient.api.tasks({ taskId: created.task.id });
      const before = await unwrapAsync(endpoint.runs.get({ headers }));
      const logsBefore = await unwrapAsync(
        routes.logs.get({ query: { from: 0, limit: 1000 }, headers }),
      );
      expect(logsBefore.lines.map((line) => line.content)).toEqual([
        "Original attempt failed",
      ]);

      await unwrapAsync(
        h.apiClient.api["step-definitions"].post(
          {
            ...definition,
            version: 2,
            prompt: "Do not use this new prompt.",
            environment: {
              ...definition.environment,
              envJson: definition.environment.envJson.map((env) => ({
                ...env,
                value: "changed",
              })),
            },
          },
          { headers },
        ),
      );
      const retried = await unwrapAsync(
        endpoint.retry.post({ expectedLatestRunId: oldId }, { headers }),
      );
      if (!retried.taskRunId) throw new Error("Expected a retry run");
      const token = await h.claim(workItemId, retried.taskRunId);
      const context = await h.workerContext(retried.taskRunId, token);
      expect(context.task).toMatchObject({
        prompt: "Use the original prompt.",
        inputJson: { ticket: "original" },
      });
      expect(context.runtime).toEqual(originalContext.runtime);
      expect(context.baseWorkBranch).toBe(originalContext.baseWorkBranch);

      const late = await routes.completions.post(
        {
          claimToken: oldToken,
          status: "succeeded",
          resultJson: { wrong: true },
          errorJson: null,
        },
        { headers },
      );
      expect(late.error?.status).toBe(409);
      expect((await unwrapAsync(endpoint.get({ headers }))).status).toBe(
        "running",
      );
      await h.completeRun(retried.taskRunId, token, {
        status: "succeeded",
        resultJson: { done: true },
      });
      const task = await unwrapAsync(endpoint.get({ headers }));
      expect(task).toMatchObject({
        status: "succeeded",
        resultJson: { done: true },
        errorJson: null,
      });
      const runs = await unwrapAsync(endpoint.runs.get({ headers }));
      expect(runs).toHaveLength(2);
      expect(runs[0]).toEqual(before[0]);
      expect(runs[0]?.errorJson).toEqual(failure);
      expect(runs[1]).toMatchObject({
        id: retried.taskRunId,
        number: 2,
        reason: "retry",
        status: "succeeded",
      });
      expect(runs[1]?.previousTaskRunId).toBe(oldId);
      expect(runs[1]?.baseBranch).toBe(runs[0]?.baseBranch);
      expect(
        await unwrapAsync(
          routes.logs.get({ query: { from: 0, limit: 1000 }, headers }),
        ),
      ).toEqual(logsBefore);
    },
  );

  concurrentTest(
    "a cancelled live claim cannot complete over its new attempt",
    async () => {
      const { headers } = h.requireSetup();
      const workItemId = await h.seedItem();
      const { taskId, taskRunId } = await h.startTask(workItemId);
      const oldToken = await h.claim(workItemId, taskRunId);
      const endpoint = h.apiClient.api.tasks({ taskId });
      await unwrapAsync(endpoint.cancel.post(undefined, { headers }));
      const retried = await unwrapAsync(
        endpoint.retry.post({ expectedLatestRunId: taskRunId }, { headers }),
      );
      if (!retried.taskRunId) throw new Error("Expected retry run");
      const token = await h.claim(workItemId, retried.taskRunId);
      await h.completeRun(retried.taskRunId, token, {
        status: "succeeded",
        resultJson: { correct: true },
      });
      const before = await unwrapAsync(endpoint.get({ headers }));
      const late = await h.apiClient.api["task-runs"]({
        taskRunId,
      }).completions.post(
        {
          claimToken: oldToken,
          status: "failed",
          resultJson: null,
          errorJson: { name: "Scarn.StepFailed", message: "late old worker" },
        },
        { headers },
      );
      expect(late.error?.status).toBe(409);
      expect(await unwrapAsync(endpoint.get({ headers }))).toEqual(before);
      expect(
        (await unwrapAsync(endpoint.runs.get({ headers }))).map(
          (run) => run.status,
        ),
      ).toEqual(["cancelled", "succeeded"]);
    },
  );

  concurrentTest(
    "a cancelled yielded Task reopens the same conversation and can yield again",
    async () => {
      const { headers } = h.requireSetup();
      const { taskId, taskRunId, conversationId, workItemId } =
        await h.handedOver("conversation", "First question?");
      const endpoint = h.apiClient.api.tasks({ taskId });
      const conversation = h.conversationRoutes(conversationId);
      await unwrapAsync(endpoint.cancel.post(undefined, { headers }));
      expect(await unwrapAsync(conversation.get({ headers }))).toMatchObject({
        status: "closed",
      });
      const retried = await unwrapAsync(
        endpoint.retry.post({ expectedLatestRunId: taskRunId }, { headers }),
      );
      if (!retried.taskRunId) throw new Error("Expected retry run");
      expect(await unwrapAsync(conversation.get({ headers }))).toMatchObject({
        status: "agent_turn",
        closedAt: null,
      });
      await h.yieldRun(workItemId, retried.taskRunId, {
        message: "Second question?",
      });
      expect(await unwrapAsync(endpoint.get({ headers }))).toMatchObject({
        status: "waiting_for_person",
        conversationId,
      });
      expect(await unwrapAsync(conversation.get({ headers }))).toMatchObject({
        status: "waiting_for_person",
      });
      const conversationView = await unwrapAsync(conversation.get({ headers }));
      expect(conversationView.messages.map((message) => message.body)).toEqual([
        "First question?",
        "Second question?",
      ]);
      expect(
        (await unwrapAsync(endpoint.runs.get({ headers }))).map(
          (run) => run.reason,
        ),
      ).toEqual(["initial", "retry"]);
    },
  );

  concurrentTest(
    "failed standalone code Tasks can be retried and completed",
    async () => {
      const { projectId, headers } = h.requireSetup();
      const step = await unwrapAsync(
        h.apiClient.api["step-definitions"].post(
          {
            projectId,
            key: `retry_code_${crypto.randomUUID()}`,
            name: "Retry code",
            description: "Code retry",
            version: 1,
            kind: "code",
            entrypointJson: { sourceFile: "steps/run.ts" },
            inputSchemaJson: { type: "object" },
            resultSchemaJson: { type: "object" },
            status: "active",
          },
          { headers },
        ),
      );
      const workItemId = await h.seedItem();
      const created = await unwrapStartedTaskAsync(
        h.apiClient.api.tasks.post(
          {
            projectId,
            workItemId,
            stepDefinitionId: step.id,
            stepDefinitionVersion: 1,
            inputJson: { code: true },
          },
          { headers },
        ),
      );
      await h.completeRun(
        created.run.id,
        await h.claim(workItemId, created.run.id),
        {
          status: "failed",
          errorJson: { name: "Scarn.StepFailed", message: "code failure" },
        },
      );
      const endpoint = h.apiClient.api.tasks({ taskId: created.task.id });
      const retried = await unwrapAsync(
        endpoint.retry.post(
          { expectedLatestRunId: created.run.id },
          { headers },
        ),
      );
      if (!retried.taskRunId) throw new Error("Expected retry run");
      const token = await h.claim(workItemId, retried.taskRunId);
      const context = await h.workerContext(retried.taskRunId, token);
      expect(context.task).toMatchObject({
        kind: "code",
        entrypointJson: { sourceFile: "steps/run.ts" },
        inputJson: { code: true },
      });
      await h.completeRun(retried.taskRunId, token, {
        status: "succeeded",
        resultJson: { done: true },
      });
      expect((await unwrapAsync(endpoint.get({ headers }))).status).toBe(
        "succeeded",
      );
      expect(
        (await unwrapAsync(endpoint.runs.get({ headers }))).map(
          (run) => run.status,
        ),
      ).toEqual(["failed", "succeeded"]);
    },
  );
});
