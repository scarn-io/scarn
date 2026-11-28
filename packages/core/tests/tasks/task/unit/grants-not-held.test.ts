import { describe, expect, test } from "bun:test";
import { grantsNotHeld, type Grant } from "@/tasks/task/domain/grants";
import { grant } from "tests/tasks/task/grants-test-support";

const projectUpdate = (labels?: string[], keyPrefix?: string): Grant => ({
  resource: "workItem",
  action: "update",
  scope: "project",
  ...(keyPrefix ? { keyPrefix } : {}),
  ...(labels ? { labels } : {}),
});

describe("grantsNotHeld", () => {
  test("keeps grants of a key not held", () => {
    expect(
      grantsNotHeld([grant("read", "self")], [grant("close", "self")]),
    ).toEqual([grant("close", "self")]);
  });

  test("drops grants held with the same key", () => {
    expect(
      grantsNotHeld(
        [grant("comment", "self"), grant("label", "self", ["a", "b"])],
        [grant("comment", "self"), grant("label", "self", ["b"])],
      ),
    ).toEqual([]);
  });

  test("narrows a partly held labelled grant to the new labels", () => {
    expect(
      grantsNotHeld(
        [grant("label", "self", ["a"])],
        [grant("label", "self", ["a", "b"])],
      ),
    ).toEqual([grant("label", "self", ["b"])]);
  });

  test("an unlimited held update covers any labels; a labelled one doesn't cover unlimited", () => {
    expect(grantsNotHeld([projectUpdate()], [projectUpdate(["x"])])).toEqual(
      [],
    );
    expect(grantsNotHeld([projectUpdate(["x"])], [projectUpdate()])).toEqual([
      projectUpdate(),
    ]);
  });

  test("a different key prefix is a different grant", () => {
    expect(
      grantsNotHeld([projectUpdate(undefined, "gh-")], [projectUpdate()]),
    ).toEqual([projectUpdate()]);
  });
});
