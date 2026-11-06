import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendWorkItemChange,
  buildWorkItemChangesPath,
  readWorkItemChanges,
  withWorkItemChangesLock,
  type WorkItemChange,
} from "../src/contracts/work-item-changes";

function comment(index: number): WorkItemChange {
  return { kind: "comment", workItemId: "item-a", body: String(index) };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scarn-work-item-changes-"));
}

describe("appendWorkItemChange", () => {
  test.concurrent("keeps every change appended in parallel", async () => {
    const workspacePath = await workspace();
    const changes = Array.from({ length: 20 }, (_, index) => comment(index));

    await Promise.all(
      changes.map((change) =>
        withWorkItemChangesLock(workspacePath, () =>
          appendWorkItemChange(workspacePath, change),
        ),
      ),
    );

    expect(await readWorkItemChanges(workspacePath)).toEqual(changes);
    const filePath = buildWorkItemChangesPath(workspacePath);
    expect(await readdir(dirname(filePath))).toEqual([
      "work-item-changes.json",
    ]);
    expect(await readFile(filePath, "utf8")).not.toContain("\u0000");
  });

  test.concurrent(
    "never lets a parallel reader see a partial file",
    async () => {
      const workspacePath = await workspace();
      const appends = Array.from({ length: 20 }, (_, index) =>
        withWorkItemChangesLock(workspacePath, () =>
          appendWorkItemChange(workspacePath, comment(index)),
        ),
      );
      const reads = Array.from({ length: 50 }, () =>
        readWorkItemChanges(workspacePath),
      );

      await Promise.all([...appends, ...reads]);

      expect(await readWorkItemChanges(workspacePath)).toHaveLength(20);
    },
  );
});

describe("withWorkItemChangesLock", () => {
  test.concurrent("runs one holder at a time per workspace", async () => {
    const workspacePath = await workspace();
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        withWorkItemChangesLock(workspacePath, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await Bun.sleep(5);
          active--;
        }),
      ),
    );

    expect(maxActive).toBe(1);
  });

  test.concurrent("releases the lock when the holder throws", async () => {
    const workspacePath = await workspace();

    const failing = withWorkItemChangesLock(workspacePath, () =>
      Promise.reject(new Error("boom")),
    );
    const next = withWorkItemChangesLock(workspacePath, () =>
      Promise.resolve("ran"),
    );

    const outcomes = await Promise.allSettled([failing, next]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(await next).toBe("ran");
  });
});
