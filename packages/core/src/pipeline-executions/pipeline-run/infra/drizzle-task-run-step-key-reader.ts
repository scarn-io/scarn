import { eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import {
  nodeVisits,
  pipelineGraphVersions,
  pipelineRuns,
  taskRuns,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TaskRunStepKeyReader } from "@scarn/core/tasks/task-run/application/task-run-step-key-reader";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";

/**
 * A pipeline Task's step key: the `step` of the node its visit is at, read
 * from the run's pinned version document.
 */
export class DrizzleTaskRunStepKeyReader implements TaskRunStepKeyReader {
  async loadStepKey(taskId: UuidV7): Promise<string | null> {
    const [row] = await getDb()
      .select({
        nodeId: nodeVisits.nodeId,
        definitionJson: pipelineGraphVersions.definitionJson,
      })
      .from(taskRuns)
      .innerJoin(nodeVisits, eq(nodeVisits.taskId, taskRuns.taskId))
      .innerJoin(pipelineRuns, eq(pipelineRuns.id, nodeVisits.pipelineRunId))
      .innerJoin(
        pipelineGraphVersions,
        eq(pipelineGraphVersions.id, pipelineRuns.pipelineGraphVersionId),
      )
      .where(eq(taskRuns.id, taskId))
      .limit(1);
    if (!row) {
      return null;
    }
    const node = (row.definitionJson as PipelineDocument).nodes[row.nodeId];
    return node?.kind === "step" ? node.step : null;
  }
}
