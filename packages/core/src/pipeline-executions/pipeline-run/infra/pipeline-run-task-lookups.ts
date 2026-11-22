import { eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { nodeVisits, pipelineRuns, tasks } from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ConversationVisitRef } from "../application/pipeline-run-repo";

/** The run whose step visit owns `taskId`, with whoever started that run; null for a standalone Task. */
export const findRunStarterByTaskId = async (
  taskId: UuidV7,
  dbExecutor?: DbExecutor,
): Promise<{ pipelineRunId: UuidV7; startedByUserId: UuidV7 | null } | null> => {
  const [row] = await (dbExecutor ?? getDb())
    .select({
      pipelineRunId: nodeVisits.pipelineRunId,
      startedByUserId: pipelineRuns.triggeredByUserId,
    })
    .from(nodeVisits)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, nodeVisits.pipelineRunId))
    .where(eq(nodeVisits.taskId, taskId))
    .limit(1);
  return row
    ? {
        pipelineRunId: row.pipelineRunId as UuidV7,
        startedByUserId: row.startedByUserId as UuidV7 | null,
      }
    : null;
};

/** The step visit whose Task owns `conversationId` (`tasks.conversation_id`). */
export const findVisitByConversationId = async (
  conversationId: UuidV7,
  dbExecutor?: DbExecutor,
): Promise<ConversationVisitRef | null> => {
  const [row] = await (dbExecutor ?? getDb())
    .select({
      pipelineRunId: nodeVisits.pipelineRunId,
      visitId: nodeVisits.id,
      nodeId: nodeVisits.nodeId,
      pipelineGraphVersionId: pipelineRuns.pipelineGraphVersionId,
    })
    .from(tasks)
    .innerJoin(nodeVisits, eq(nodeVisits.taskId, tasks.id))
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, nodeVisits.pipelineRunId))
    .where(eq(tasks.conversationId, conversationId))
    .limit(1);
  return row
    ? {
        pipelineRunId: row.pipelineRunId as UuidV7,
        visitId: row.visitId as UuidV7,
        nodeId: row.nodeId,
        pipelineGraphVersionId: row.pipelineGraphVersionId as UuidV7,
      }
    : null;
};
