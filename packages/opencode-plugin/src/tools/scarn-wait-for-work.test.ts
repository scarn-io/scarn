import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  WAIT_FOR_WORK_ACCEPTED_MESSAGE,
  WAIT_FOR_WORK_RELATIVE_PATH,
  waitForWork,
} from "./scarn-wait-for-work";

describe("waitForWork", () => {
  test("writes the marker and tells the agent to end its turn", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-wait-for-work-"),
    );

    expect(await waitForWork(workspacePath)).toBe(
      WAIT_FOR_WORK_ACCEPTED_MESSAGE,
    );
    const marker = JSON.parse(
      await readFile(
        path.join(workspacePath, WAIT_FOR_WORK_RELATIVE_PATH),
        "utf8",
      ),
    ) as { requestedAt?: unknown };
    expect(typeof marker.requestedAt).toBe("string");
  });
});
