import { describe, expect, test } from "bun:test";
import { loadCurrentExecutionInfo, type Grant } from "./current-execution";
import { workItemTestWorkspace } from "./work-item-test-workspace";

// eslint-disable-next-line local/no-unknown-parameter-type -- tests feed it junk on purpose
async function loadGrants(grants: unknown) {
  const workspacePath = await workItemTestWorkspace({ grants });
  return (await loadCurrentExecutionInfo(workspacePath)).grants;
}

describe("loadCurrentExecutionInfo grants", () => {
  test.concurrent("reads valid grants", async () => {
    const grants: Grant[] = [
      { resource: "workItem", action: "read", scope: "self" },
      { resource: "workItem", action: "close", scope: "children" },
      {
        resource: "workItem",
        action: "label",
        scope: "self",
        labels: ["bug"],
      },
      {
        resource: "workItem",
        action: "create",
        scope: "children",
        labels: ["task"],
      },
    ];

    expect(await loadGrants(grants)).toEqual(grants);
  });

  test.concurrent("treats missing grants as none", async () => {
    expect(await loadGrants(undefined)).toEqual([]);
    expect(await loadGrants("read")).toEqual([]);
  });

  test.concurrent("drops entries that aren't grants", async () => {
    const read: Grant = { resource: "workItem", action: "read", scope: "self" };

    expect(
      await loadGrants([
        read,
        "read",
        null,
        { resource: "project", action: "read", scope: "self" },
        { resource: "workItem", action: "delete", scope: "self" },
        { resource: "workItem", action: "read", scope: "siblings" },
        { resource: "workItem", action: "label", scope: "self" },
        { resource: "workItem", action: "label", scope: "self", labels: [1] },
        {
          resource: "workItem",
          action: "create",
          scope: "self",
          labels: [],
        },
      ]),
    ).toEqual([read]);
  });

  test.concurrent("ignores the old workItemPermissions field", async () => {
    const workspacePath = await workItemTestWorkspace({
      grants: undefined,
      workItemPermissions: ["self", "children"],
    });

    expect((await loadCurrentExecutionInfo(workspacePath)).grants).toEqual([]);
  });
});
