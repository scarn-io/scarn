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
import { readStoredPipelineDocument } from "@scarn/core/pipeline-definitions/pipeline-graph/contracts/pipeline-graph-version-stored";
import { PersistenceError } from "@scarn/core/lib/errors";

/**
 * A pipeline Task's step key: the `step` of the node its visit is at, read
 * from the run's pinned version document.
 */
export class DrizzleTaskRunStepKeyReader implements TaskRunStepKeyReader {
  async loadStepKey(taskId: UuidV7): Promise<string | null> {
    const [row] = await getDb()
      .select({
        nodeId: nodeVisits.nodeId,
        pipelineGraphVersionId: pipelineGraphVersions.id,
        definitionJson: pipelineGraphVersions.definitionJson,
        schemaVersion: pipelineGraphVersions.schemaVersion,
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
    const read = readStoredPipelineDocument(row.schemaVersion, row);
    if (!read.success) {
      throw new PersistenceError(
        `pipeline graph version ${row.pipelineGraphVersionId} is unreadable: ${read.reason}`,
        "PIPELINE_GRAPH_VERSION_ROW_UNREADABLE",
      );
    }
    const node = read.value.nodes[row.nodeId];
    return node?.kind === "step" ? node.step : null;
  }
}
