import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  DEFAULT_WORK_ITEM_SORT,
  formatWorkItemSort,
  parseWorkItemSort,
  resolveWorkItemSort,
  type WorkItemSort,
} from "./project-work-items-params";

const parse = (token: string | undefined): WorkItemSort | undefined =>
  parseWorkItemSort(
    new URLSearchParams(token !== undefined ? { sort: token } : {}),
  );

const resolve = (token: string | undefined): WorkItemSort =>
  resolveWorkItemSort(
    new URLSearchParams(token !== undefined ? { sort: token } : {}),
  );

const PIPELINE_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001");

/**
 * `parseWorkItemSort` is a thin wrapper over the shared
 * `parseWorkItemSortToken` from `@scarn/core` (see `project-work-items-
 * params.ts`'s doc comment for why it's imported rather than duplicated).
 * These cases exercise that shared grammar through the wrapper the browser
 * actually calls, so a regression in either half shows up here.
 */
describe("parseWorkItemSort / formatWorkItemSort round trip", () => {
  const cases: { name: string; token: string; sort: WorkItemSort }[] = [
    {
      name: "created, descending",
      token: "created-desc",
      sort: { kind: "created", direction: "desc" },
    },
    {
      name: "created, ascending",
      token: "created-asc",
      sort: { kind: "created", direction: "asc" },
    },
    {
      name: "updated, descending",
      token: "updated-desc",
      sort: { kind: "updated", direction: "desc" },
    },
    {
      name: "updated, ascending",
      token: "updated-asc",
      sort: { kind: "updated", direction: "asc" },
    },
    {
      name: "score, descending",
      token: `score:${PIPELINE_ID}:triage:severity:desc`,
      sort: {
        kind: "score",
        pipelineDefinitionId: PIPELINE_ID,
        stepKey: "triage",
        signalKey: "severity",
        direction: "desc",
      },
    },
    {
      name: "score, ascending",
      token: `score:${PIPELINE_ID}:triage:severity:asc`,
      sort: {
        kind: "score",
        pipelineDefinitionId: PIPELINE_ID,
        stepKey: "triage",
        signalKey: "severity",
        direction: "asc",
      },
    },
  ];

  for (const { name, token, sort } of cases) {
    test(`${name} round-trips`, () => {
      expect(parse(token)).toEqual(sort);
      expect(formatWorkItemSort(sort)).toBe(token);
    });
  }

  test("no `sort` param parses to `undefined`", () => {
    expect(parse(undefined)).toBeUndefined();
  });

  test.each([
    "",
    "bogus",
    "created-sideways",
    "created",
    "score:onlyOnePart",
    `score:${PIPELINE_ID}:triage`,
    `score:${PIPELINE_ID}:triage:severity:sideways`,
  ])("malformed token %p drops the sort silently", (token) => {
    expect(parse(token)).toBeUndefined();
  });

  test("a `score:` token with a non-UUID pipeline id is rejected", () => {
    expect(parse("score:not-a-uuid:triage:severity:desc")).toBeUndefined();
  });
});

/**
 * `resolveWorkItemSort` is `parseWorkItemSort` with `DEFAULT_WORK_ITEM_SORT`
 * substituted for `undefined` — every case that used to drop the sort must
 * now resolve to that default instead, and a valid token must still pass
 * through unchanged.
 */
describe("resolveWorkItemSort", () => {
  test("no `sort` param resolves to the default", () => {
    expect(resolve(undefined)).toEqual(DEFAULT_WORK_ITEM_SORT);
  });

  test.each([
    "",
    "bogus",
    "created-sideways",
    "created",
    "score:onlyOnePart",
    `score:${PIPELINE_ID}:triage`,
    `score:${PIPELINE_ID}:triage:severity:sideways`,
  ])("malformed token %p resolves to the default", (token) => {
    expect(resolve(token)).toEqual(DEFAULT_WORK_ITEM_SORT);
  });

  test("a `score:` token with a non-UUID pipeline id resolves to the default", () => {
    expect(resolve("score:not-a-uuid:triage:severity:desc")).toEqual(
      DEFAULT_WORK_ITEM_SORT,
    );
  });

  test("a valid token passes through unchanged", () => {
    expect(resolve("created-asc")).toEqual({
      kind: "created",
      direction: "asc",
    });
  });
});
