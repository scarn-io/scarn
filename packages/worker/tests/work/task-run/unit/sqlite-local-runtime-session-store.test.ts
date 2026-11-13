import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteLocalRuntimeSessionStore } from "../../../../src/work/task-run/infra/sqlite-local-runtime-session-store";

describe("SqliteLocalRuntimeSessionStore.listRecent", () => {
  let dir: string;
  let store: SqliteLocalRuntimeSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "scarn-session-store-"));
    store = new SqliteLocalRuntimeSessionStore(path.join(dir, "db.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function finish(id: string, projectId: string, outcome: "ok" | "fail") {
    store.createSession({ id, projectId, taskRunId: `task-${id}` });
    if (outcome === "ok") {
      store.markSucceeded({ id });
    } else {
      store.markFailed({ id, failureReason: "boom" });
    }
  }

  test("returns finished sessions for the given projects, newest first", async () => {
    finish("s1", "p1", "ok");
    await Bun.sleep(2);
    finish("s2", "p2", "fail");
    await Bun.sleep(2);
    finish("s3", "other", "ok");
    store.createSession({ id: "s4", projectId: "p1", taskRunId: "task-s4" });

    const recent = store.listRecent(10, ["p1", "p2"]);

    expect(recent.map((r) => r.id)).toEqual(["s2", "s1"]);
    expect(recent[0]).toMatchObject({
      projectId: "p2",
      taskRunId: "task-s2",
      status: "failed",
      failureReason: "boom",
    });
    expect(recent[0]?.completedAt).not.toBeNull();
  });

  test("honours the limit and empty project lists", () => {
    finish("s1", "p1", "ok");
    finish("s2", "p1", "ok");

    expect(store.listRecent(1, ["p1"])).toHaveLength(1);
    expect(store.listRecent(5, [])).toEqual([]);
    expect(store.listRecent(0, ["p1"])).toEqual([]);
  });
});
