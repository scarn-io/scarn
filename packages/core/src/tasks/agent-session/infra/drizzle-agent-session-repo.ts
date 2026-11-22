import { asc, eq } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { agentSessions } from "@scarn/core/lib/db/schema";
import { isUniqueViolation } from "@scarn/core/lib/db/unique-violation";
import {
  PersistenceError,
  ResourceConflictError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import type { AgentSessionRepo } from "../application/agent-session-repo";
import { AgentSessionEntity } from "../domain/agent-session-entity";

type AgentSessionRow = typeof agentSessions.$inferSelect;

const toEntity = (row: AgentSessionRow): AgentSessionEntity =>
  AgentSessionEntity.rehydrate({
    id: row.id as UuidV7,
    taskRunId: row.taskRunId as UuidV7,
    conversationRootId: row.conversationRootId as UuidV7 | null,
    parentAgentSessionId: row.parentAgentSessionId as UuidV7 | null,
    provider: row.provider,
    externalSessionId: row.externalSessionId,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const toRow = (agentSession: AgentSessionEntity) => ({
  id: agentSession.id,
  taskRunId: agentSession.taskRunId,
  conversationRootId: agentSession.conversationRootId,
  parentAgentSessionId: agentSession.parentAgentSessionId,
  provider: agentSession.provider,
  externalSessionId: agentSession.externalSessionId,
  status: agentSession.status,
  startedAt: agentSession.startedAt,
  endedAt: agentSession.endedAt,
  createdAt: agentSession.createdAt ?? new Date(),
  updatedAt: agentSession.updatedAt ?? new Date(),
});

const conflictOf = (agentSession: AgentSessionEntity) =>
  new ResourceConflictError(
    "agent session",
    `${agentSession.provider}/${agentSession.externalSessionId}`,
  );

export class DrizzleAgentSessionRepo implements AgentSessionRepo {
  async load(id: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);

    return row ? toEntity(row) : null;
  }

  async create(agentSession: AgentSessionEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    let row: AgentSessionRow | undefined;
    try {
      [row] = await db
        .insert(agentSessions)
        .values(toRow(agentSession))
        .returning();
    } catch (error) {
      if (isUniqueViolation(error as Error)) {
        throw conflictOf(agentSession);
      }
      throw error;
    }

    if (!row) {
      throw new PersistenceError(
        `Failed to create agent session ${agentSession.id}`,
        "AGENT_SESSION_CREATE_FAILED",
      );
    }

    return toEntity(row);
  }

  async save(agentSession: AgentSessionEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    let row: AgentSessionRow | undefined;
    try {
      [row] = await db
        .update(agentSessions)
        .set({
          conversationRootId: agentSession.conversationRootId,
          parentAgentSessionId: agentSession.parentAgentSessionId,
          provider: agentSession.provider,
          externalSessionId: agentSession.externalSessionId,
          status: agentSession.status,
          endedAt: agentSession.endedAt,
          updatedAt: agentSession.updatedAt ?? new Date(),
        })
        .where(eq(agentSessions.id, agentSession.id))
        .returning();
    } catch (error) {
      if (isUniqueViolation(error as Error)) {
        throw conflictOf(agentSession);
      }
      throw error;
    }

    if (!row) {
      throw new ResourceNotFoundError("agent session", agentSession.id);
    }

    return toEntity(row);
  }

  async listByTaskId(taskRunId: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.taskRunId, taskRunId))
      .orderBy(asc(agentSessions.startedAt), asc(agentSessions.id));

    return rows.map(toEntity);
  }
}
