import { describe, expect, test } from "bun:test";
import { editStepEnvironment } from "./step-definition-dialog-helpers";

describe("editStepEnvironment named selections", () => {
  const inline = {
    kind: "inline",
    runtime: { kind: "devcontainer", config: ".devcontainer/custom.json" },
    envJson: [],
  } as const;
  const selection = { edited: true, managedRuntime: "bun1" } as const;

  test("switching to named clears inline-only fields", () => {
    expect(
      editStepEnvironment(
        { ...inline, envJson: [] },
        { ...selection, kind: "named", environmentName: "shared-build" },
      ),
    ).toEqual({ kind: "named", name: "shared-build" });
  });

  test("editing a name replaces the named reference", () => {
    expect(
      editStepEnvironment(
        { kind: "named", name: "old" },
        { ...selection, kind: "named", environmentName: "new" },
      ),
    ).toEqual({ kind: "named", name: "new" });
  });

  test.each(["", "Uppercase", "../secret", "has space", "has_underscore"])(
    "rejects invalid name %s",
    (environmentName) => {
      expect(() =>
        editStepEnvironment(null, {
          ...selection,
          kind: "named",
          environmentName,
        }),
      ).toThrow("Environment name must");
    },
  );

  test("switching through named does not restore discarded inline fields", () => {
    expect(
      editStepEnvironment(
        { ...inline, envJson: [] },
        { ...selection, kind: "devcontainer", resetInline: true },
      ),
    ).toEqual({ kind: "inline", runtime: { kind: "devcontainer" } });
  });
});
