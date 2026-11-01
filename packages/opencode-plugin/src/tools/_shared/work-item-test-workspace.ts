import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_EXECUTION_INFO_RELATIVE_PATH } from "./current-execution";

/** Test support: a temp workspace with the given execution info fields. */
export async function workItemTestWorkspace(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "scarn-wi-"));
  const infoPath = path.join(
    workspacePath,
    CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  );
  await mkdir(path.dirname(infoPath), { recursive: true });
  await Bun.write(
    infoPath,
    JSON.stringify({
      taskRunId: "task-run-1",
      resultSchemaJson: null,
      turnsRemaining: 3,
      workItemId: "item-self",
      workItemPermissions: ["self", "children"],
      api: { baseUrl: "http://api.test/", claimToken: "claim-1" },
      ...overrides,
    }),
  );
  return workspacePath;
}
