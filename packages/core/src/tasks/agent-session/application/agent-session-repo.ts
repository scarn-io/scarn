import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { AgentSessionEntity } from "../domain/agent-session-entity";

export type AgentSessionRepo = {
  load(id: UuidV7, dbExecutor?: DbExecutor): Promise<AgentSessionEntity | null>;
  create(
    agentSession: AgentSessionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AgentSessionEntity>;
  save(
    agentSession: AgentSessionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AgentSessionEntity>;
  listByTaskId(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<AgentSessionEntity[]>;
};
