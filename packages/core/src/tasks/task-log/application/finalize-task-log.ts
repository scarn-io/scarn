import { gzipSync } from "node:zlib";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { OrganizationEntity } from "@scarn/core/organizations/organization/domain/organization-entity";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { UsageMeterRepo } from "@scarn/core/billing/usage-meter/application/usage-meter-repo";
import { ensureUsageAllowed } from "@scarn/core/billing/usage-meter/application/ensure-usage-allowed";
import { LogArchivedDomainEvent } from "../domain/log-archived.domain-event";
import type { LogLineContract } from "../contracts/task-log-contracts";
import type { LogFeedStore } from "./log-feed-store";
import { taskLogArchivePrefix } from "../domain/task-log-archive-prefix";

/** Object-storage key for a task's finalized log archive. */
export const taskLogArchiveKey = (taskRunId: string): string =>
  `${taskLogArchivePrefix(taskRunId)}log.ndjson`;

const toNdjson = (lines: LogLineContract[]): string =>
  lines.map((line) => JSON.stringify(line)).join("\n") +
  (lines.length ? "\n" : "");

/**
 * Flush a completed task's live feed to the durable object-storage archive,
 * record the archive metadata, then purge the hot feed.
 *
 * Designed to be called from within the task-completion transaction. It never
 * throws: if the object store is unavailable it logs and leaves the feed in
 * place (the DO feed's own expiry alarm is the backstop). It returns whether
 * the log is kept —
 * `true` once the archive is written, or when `objectStore` is null (object
 * storage not configured, so the live feed counts as kept and is left
 * intact); `false` when the archive was skipped over cap or failed. A caller
 * whose completion depends on the log (agent work item changes) fails the run
 * on `false`.
 *
 * On a SUCCESSFUL archive write it emits a {@link LogArchivedDomainEvent} so
 * billing handlers can account usage (Phase 4). Event emission is part of the
 * best-effort path: resolving the owning org or publishing the event must NOT
 * break task completion, so any failure there is caught and logged, never
 * thrown. The event is only emitted when an `orgRepo` + `domainEventDispatcher`
 * are wired and the call is running inside a transaction.
 *
 * HARD-CAP ENFORCEMENT (Phase 5): before writing, a pre-flight quota guard
 * checks the org's WRITE (and STORAGE, for the bytes about to be written) caps.
 * When over cap the archive is SKIPPED — no S3 write, no metadata — and it
 * returns `false`. Nothing retries a Durable Object feed, so over cap means the
 * log is not kept: the hot feed is purged (best effort; a failure is logged).
 * For the DO store that seals the feed so the writer stops and the DO deletes
 * itself within an hour; the seal is an HTTP call outside the completion
 * transaction, so a rollback of that transaction leaves the feed sealed. A
 * quota result NEVER throws out of this path. The
 * guard is only applied when `orgRepo` + `usageMeterRepo` are wired and the call
 * runs inside a transaction (so the guard's `FOR UPDATE` lock is held across the
 * subsequent accounting); otherwise archival proceeds unguarded (e.g. tests).
 */
export const finalizeTaskLog = async (
  taskRunId: UuidV7,
  projectId: UuidV7,
  {
    taskRunRepo,
    logFeedStore,
    objectStore,
    orgRepo,
    usageMeterRepo,
    timeProvider,
    domainEventDispatcher,
    logger,
    dbExecutor,
  }: {
    taskRunRepo: TaskRunRepo;
    logFeedStore: LogFeedStore;
    objectStore: ObjectStore | null;
    orgRepo?: OrgRepo | undefined;
    usageMeterRepo?: UsageMeterRepo | undefined;
    timeProvider?: TimeProvider | undefined;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<boolean> => {
  if (!objectStore) {
    // Object storage not configured (e.g. S3_BUCKET unset). Archival degrades
    // gracefully, but warn so a misconfigured environment that silently archives
    // NOTHING is visible instead of failing invisibly. The hot feed is left in
    // place so a later flush (once storage is wired up) can still archive it.
    logger?.warn(
      { taskRunId, projectId },
      "Skipping log archive: object storage not configured",
    );
    return true;
  }

  try {
    const lines = await logFeedStore.readAll(taskRunId, dbExecutor);
    const key = taskLogArchiveKey(taskRunId);
    const body = toNdjson(lines);
    // The archive is stored gzip-compressed, so meter the quota guard against
    // the compressed size — that's what actually lands in object storage and
    // what `putObject` reports back for usage accounting.
    const wouldWriteBytes = gzipSync(Buffer.from(body, "utf8")).byteLength;

    // Resolve the owning org once: reused for both the pre-flight write guard
    // and the post-write usage event so we never double-fetch.
    const org =
      orgRepo && dbExecutor
        ? await orgRepo.findByProjectId(projectId, dbExecutor)
        : null;

    if (org && usageMeterRepo && timeProvider && dbExecutor) {
      const allowed = await ensureUsageAllowed(
        org.id,
        "write",
        { addBytes: wouldWriteBytes },
        { usageMeterRepo, timeProvider, dbExecutor },
      );
      if (!allowed.ok) {
        logger?.warn(
          {
            taskRunId,
            orgId: org.id,
            kind: allowed.error.kind,
            wouldWriteBytes,
          },
          "Skipping log archive: usage limit reached",
        );
        await discardFeed(taskRunId, { logFeedStore, logger, dbExecutor });
        return false;
      }
    }

    const { sizeBytes } = await objectStore.putObject({
      key,
      body,
      contentType: "application/x-ndjson",
      compress: true,
    });
    await taskRunRepo.setLogArchive(
      taskRunId,
      { storeRef: key, sizeBytes },
      dbExecutor,
    );
    await logFeedStore.purge(taskRunId, dbExecutor);

    await emitLogArchivedEvent(
      { taskRunId, projectId, sizeBytes },
      { org, domainEventDispatcher, logger, dbExecutor },
    );
    return true;
  } catch (error) {
    logger?.error({ taskRunId, error }, "Failed to finalize task log archive");
    return false;
  }
};

/**
 * Best-effort purge of a feed whose log won't be kept. A failure is logged and
 * swallowed: the DO feed's expiry alarm still deletes it eventually.
 */
export const discardFeed = async (
  taskRunId: UuidV7,
  {
    logFeedStore,
    logger,
    dbExecutor,
  }: {
    logFeedStore: LogFeedStore;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<void> => {
  try {
    await logFeedStore.purge(taskRunId, dbExecutor);
  } catch (error) {
    logger?.error(
      { taskRunId, error },
      "Failed to purge task log feed after skipping archive",
    );
  }
};

/**
 * Best-effort emission of {@link LogArchivedDomainEvent}. Publishes within the
 * active transaction using the org already resolved by the caller (it ran the
 * write guard against the same org, so we never re-fetch). Any failure is logged
 * and swallowed so usage accounting can never break task completion.
 */
const emitLogArchivedEvent = async (
  archive: { taskRunId: UuidV7; projectId: UuidV7; sizeBytes: number },
  {
    org,
    domainEventDispatcher,
    logger,
    dbExecutor,
  }: {
    org: OrganizationEntity | null;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<void> => {
  if (!org || !domainEventDispatcher || !dbExecutor) {
    return;
  }

  const publish = async (tx: DbTransaction): Promise<void> => {
    await domainEventDispatcher.publish(
      [
        new LogArchivedDomainEvent({
          orgId: org.id,
          projectId: archive.projectId,
          taskRunId: archive.taskRunId,
          sizeBytes: archive.sizeBytes,
        }),
      ],
      tx,
    );
  };

  try {
    // finalizeTaskLog runs inside the task-completion transaction, so
    // `dbExecutor` is that transaction. Opening a transaction on it nests as a
    // savepoint that participates in the same tx, giving the usage handler the
    // `FOR UPDATE` lock it needs while keeping accounting in the same atomic unit.
    await dbExecutor.transaction(async (tx) => {
      await publish(tx);
    });
  } catch (error) {
    logger?.error(
      { taskRunId: archive.taskRunId, error },
      "Failed to emit log-archived usage event",
    );
  }
};
