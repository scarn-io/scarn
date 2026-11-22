import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  decodeProjectRunsCursor,
  encodeProjectRunsCursor,
} from "@scarn/core/pipeline-executions/project-runs/application/list-project-runs";
import { projectRunsCounts } from "@scarn/core/pipeline-executions/project-runs/application/project-runs-counts";
import type { ProjectRunCountGroup } from "@scarn/core/pipeline-executions/project-runs/application/project-runs-reader";

const pipelineId = createUuidV7();
const automation = { id: createUuidV7(), key: "nightly", title: null };

const group = (
  overrides: Partial<ProjectRunCountGroup>,
): ProjectRunCountGroup => ({
  status: "running",
  type: "pipeline",
  whatRanFilter: pipelineId,
  whatRanName: "Review",
  startedByAutomation: null,
  startedByActor: false,
  atNode: true,
  count: 1,
  ...overrides,
});

const groups = [
  group({ status: "needs-you", count: 2, startedByActor: true }),
  group({ status: "done", count: 3, startedByAutomation: automation }),
  group({
    status: "queued",
    type: "task",
    whatRanFilter: "task",
    whatRanName: "Task",
    count: 4,
    atNode: false,
  }),
];

describe("projectRunsCounts", () => {
  test("rolls groups up into tabs and facets", () => {
    const counts = projectRunsCounts(groups, {}, true);
    expect(counts.tabs).toEqual({
      "needs-you": 2,
      open: 6,
      finished: 3,
      all: 9,
    });
    expect(counts.overall).toEqual({ inProgress: 6, needsYou: true });
    expect(counts.startedBy).toEqual([
      { filter: "me", label: "You", inProgress: 2, needsYou: true },
      {
        filter: automation.id,
        label: "nightly",
        inProgress: 0,
        needsYou: false,
      },
    ]);
    expect(counts.whatRan.map((entry) => entry.whatRan.kind)).toEqual([
      "pipeline",
      "task",
    ]);
  });

  test("atNode narrows the tabs and the startedBy facet", () => {
    const counts = projectRunsCounts(
      groups,
      { whatRan: pipelineId, atNode: "build" },
      false,
    );
    expect(counts.tabs.all).toBe(5);
    expect(counts.startedBy).toEqual([
      {
        filter: automation.id,
        label: "nightly",
        inProgress: 0,
        needsYou: false,
      },
    ]);
    expect(counts.whatRan).toHaveLength(2);
  });

  test("startedBy narrows the whatRan facet, not its own", () => {
    const counts = projectRunsCounts(groups, { startedBy: "me" }, true);
    expect(counts.tabs.all).toBe(2);
    expect(counts.whatRan).toEqual([
      {
        filter: pipelineId,
        whatRan: { kind: "pipeline", id: pipelineId, name: "Review" },
        inProgress: 2,
        needsYou: true,
      },
    ]);
    expect(counts.startedBy).toHaveLength(2);
  });
});

describe("project runs cursor", () => {
  test("round-trips", () => {
    const cursor = {
      updatedAt: "2026-05-01T10:00:00.123456Z",
      id: createUuidV7(),
    };
    expect(decodeProjectRunsCursor(encodeProjectRunsCursor(cursor))).toEqual(
      cursor,
    );
  });

  test("rejects garbage", () => {
    expect(() => decodeProjectRunsCursor("garbage")).toThrow();
    expect(() =>
      decodeProjectRunsCursor(
        Buffer.from("2026-05-01T10:00:00Z|nope").toString("base64url"),
      ),
    ).toThrow();
  });
});
