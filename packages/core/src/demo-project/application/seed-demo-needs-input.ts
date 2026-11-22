import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { AppContext } from "@scarn/core/lib/di";
import { noopAnalytics } from "@scarn/core/lib/analytics/analytics-port";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { createPipelineRun } from "@scarn/core/pipeline-executions/pipeline-run/application/create-pipeline-run";
import { answerQuestionAndAdvance } from "@scarn/core/pipeline-executions/pipeline-run/application/comment-and-advance";
import { upsertWorkItem } from "@scarn/core/work-items/work-item/application/upsert-work-item";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import { claimNextDemoStep, completeDemoStep } from "./drive-demo-pipeline-run";
import {
  ensureDemoPipelineDocument,
  ensureDemoStepDefinitions,
} from "./ensure-demo-pipeline-document";
import { assessmentLogLines } from "./seed-demo-execution-log-templates";
import {
  ANSWERED_REPORT_RESULT,
  DEMO_TEAMMATE_REPLY,
  NEEDS_INPUT_PIPELINE_DOCUMENT,
  NEEDS_INPUT_PIPELINE_NAME,
  NEEDS_INPUT_STEP_DEFINITIONS,
  THIN_REPORT_RESULT,
} from "./needs-input-pipeline-fixture";

/**
 * Seeds the `Ask the Reporter` pipeline (`needs-input-pipeline-fixture.ts`)
 * with two runs of the same thin ticket, so the demo shows both halves of
 * ask-and-resume:
 *
 * - **waiting**: `assess-report` found the ticket too thin, and the run is
 *   parked on `ask-for-details` with an open question comment. The work item
 *   shows **Waiting for reply** and a Reply box.
 * - **answered**: the same question, a teammate's reply, a second
 *   `assess-report` that read the reply, and the run at `done`.
 *
 * Each step is driven through the real claim/complete path and the reply
 * through `answerQuestionAndAdvance`, so the engine posts the question and
 * resumes the run exactly as it would for a real worker and a real teammate.
 */

export const NEEDS_INPUT_WAITING_WORK_ITEM_PLATFORM_KEY =
  "demo-needs-input-waiting";
export const NEEDS_INPUT_ANSWERED_WORK_ITEM_PLATFORM_KEY =
  "demo-needs-input-answered";

const THIN_TICKET = {
  title: "Export is broken",
  description:
    "Tried to export the report today and it doesn't work. Can someone look?",
};

const WORK_ITEMS = [
  {
    platformKey: NEEDS_INPUT_WAITING_WORK_ITEM_PLATFORM_KEY,
    daysAgo: 0,
    answered: false,
  },
  {
    platformKey: NEEDS_INPUT_ANSWERED_WORK_ITEM_PLATFORM_KEY,
    daysAgo: 1,
    answered: true,
  },
] as const;

type SeedInput = {
  projectId: UuidV7;
  userAuthz: UserAuthorizationService;
  workItemId: UuidV7;
  pipelineRunId: UuidV7;
};

const completeNextAssessment = async (
  appContext: AppContext,
  input: SeedInput,
  resultJson: AnyJsonValue & { restatedProblem: string },
): Promise<void> => {
  const claimed = await claimNextDemoStep(appContext, input);
  if (!claimed) {
    throw new InvariantViolationError(
      `Demo run ${input.pipelineRunId} has no queued assess-report task`,
      "DEMO_SEED_NEEDS_INPUT_MISSING_STEP",
    );
  }
  await appContext.logFeedStore.append(
    parseUuidV7(claimed.claim.task.id),
    assessmentLogLines(
      "Assess Report",
      appContext.timeProvider.now(),
      resultJson.restatedProblem,
    ),
  );
  await completeDemoStep(appContext, input.userAuthz, claimed, {
    status: "succeeded",
    resultJson,
    errorJson: null,
  });
};

const replyToOpenQuestion = async (
  appContext: AppContext,
  input: SeedInput,
): Promise<void> => {
  const [question] = (
    await appContext.nodeVisitQuestionRepo.loadByRunId(input.pipelineRunId)
  ).filter((entry) => entry.status === "open");
  if (!question) {
    throw new InvariantViolationError(
      `Demo run ${input.pipelineRunId} asked no question`,
      "DEMO_SEED_NEEDS_INPUT_MISSING_QUESTION",
    );
  }
  await answerQuestionAndAdvance(
    {
      pipelineExecutionId: input.pipelineRunId,
      questionId: question.id,
      body: DEMO_TEAMMATE_REPLY,
    },
    { ...appContext, analytics: noopAnalytics, userAuthz: input.userAuthz },
  );
};

const ensureWorkItem = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
  fixture: (typeof WORK_ITEMS)[number],
): Promise<UuidV7> => {
  const now = appContext.timeProvider.now();
  const upserted = await upsertWorkItem(
    {
      projectId,
      platform: "scarn",
      platformId: fixture.platformKey,
      platformKey: fixture.platformKey,
      url: null,
      title: THIN_TICKET.title,
      description: THIN_TICKET.description,
      sourceCreatedAt: null,
      sourceUpdatedAt: new Date(
        now.getTime() - fixture.daysAgo * 24 * 60 * 60 * 1000,
      ).toISOString(),
      state: fixture.answered ? "closed" : "open",
      fields: {},
    },
    {
      userAuthz,
      workItemRepo: appContext.workItemRepo,
      workItemBlockRepo: appContext.workItemBlockRepo,
      workItemEvents: appContext.workItemEvents,
      timeProvider: appContext.timeProvider,
    },
  );
  return parseUuidV7(upserted.id);
};

/**
 * Idempotently seeds the pipeline and both runs. A work item that already has
 * a run of this pipeline is left alone; re-driving goes through
 * `resetDemoNeedsInput` first.
 */
export const ensureDemoNeedsInput = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
): Promise<void> => {
  await ensureDemoStepDefinitions(
    appContext,
    projectId,
    userAuthz,
    NEEDS_INPUT_STEP_DEFINITIONS,
  );
  const pipelineDefinitionId = await ensureDemoPipelineDocument(
    appContext,
    projectId,
    userAuthz,
    {
      name: NEEDS_INPUT_PIPELINE_NAME,
      document: NEEDS_INPUT_PIPELINE_DOCUMENT,
    },
  );

  for (const fixture of WORK_ITEMS) {
    const workItemId = await ensureWorkItem(
      appContext,
      projectId,
      userAuthz,
      fixture,
    );
    const existing =
      await appContext.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
        parseWorkItemId(workItemId),
        pipelineDefinitionId,
      );
    if (existing.length > 0) {
      continue;
    }

    const run = Result.unwrap(
      await createPipelineRun(
        { projectId, workItemId, pipelineDefinitionId },
        {
          ...appContext,
          analytics: noopAnalytics,
          userAuthz,
          triggeredBy: "system",
        },
      ),
    );
    const input: SeedInput = {
      projectId,
      userAuthz,
      workItemId,
      pipelineRunId: parseUuidV7(run.id),
    };

    await completeNextAssessment(appContext, input, THIN_REPORT_RESULT);
    if (fixture.answered) {
      await replyToOpenQuestion(appContext, input);
      await completeNextAssessment(appContext, input, ANSWERED_REPORT_RESULT);
    }
  }
};

/**
 * Deletes both work items' runs and their comments. The comments have to go
 * too: a run's question comments belong to the work item, so a re-seed would
 * otherwise post a second question next to the first.
 */
export const resetDemoNeedsInput = async (
  appContext: AppContext,
  projectId: UuidV7,
): Promise<void> => {
  const handle = await appContext.pipelineGraphRepo.findHandleByKey(
    projectId,
    NEEDS_INPUT_PIPELINE_DOCUMENT.key,
  );
  for (const fixture of WORK_ITEMS) {
    const workItem = await appContext.workItemRepo.loadByPlatformIdentity(
      projectId,
      "scarn",
      fixture.platformKey,
    );
    if (!workItem) {
      continue;
    }
    if (handle) {
      const orphanedTaskIds =
        await appContext.pipelineRunRepo.deleteByWorkItemAndPipelineGraphId(
          workItem.id,
          handle.id,
        );
      if (orphanedTaskIds.length > 0) {
        await appContext.taskRepo.deleteMany(orphanedTaskIds);
      }
    }
    const comments = await appContext.workItemCommentRepo.loadByWorkItemId(
      parseUuidV7(workItem.id),
    );
    for (const comment of comments.filter(
      (entry) => entry.parentCommentId === null,
    )) {
      await appContext.workItemCommentRepo.delete(comment.id);
    }
  }
};
