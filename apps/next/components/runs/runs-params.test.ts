import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  parseRunsNav,
  patchRunsNav,
  runsNavHref,
  runsQueryFromKey,
  runsQueryKey,
  runsQueryOf,
} from "./runs-params";

const pipelineId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa600");
const automationId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa601");
const itemId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa602");
const scheduleId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa603");

const parse = (search: string) => parseRunsNav(new URLSearchParams(search));

describe("parseRunsNav", () => {
  test("defaults to the In progress tab with no filters", () => {
    expect(parse("")).toEqual({ status: "open" });
  });

  test("reads every key and maps them onto the API query", () => {
    const nav = parse(
      `status=ended&whatRan=${pipelineId}&by=${automationId}&item=${itemId}&at=review&q=%20login%20`,
    );
    expect(nav).toEqual({
      status: "ended",
      whatRan: pipelineId,
      by: automationId,
      item: itemId,
      at: "review",
      q: "login",
    });
    expect(runsQueryOf(nav)).toEqual({
      status: "ended",
      whatRan: pipelineId,
      startedBy: automationId,
      workItemId: itemId,
      atNode: "review",
      q: "login",
    });
  });

  test("junk values fall back to their defaults", () => {
    expect(
      parse("status=nope&whatRan=bad&by=someone&item=42&q=%20%20"),
    ).toEqual({ status: "open" });
  });

  test("accepts the word filters", () => {
    expect(parse("whatRan=task&by=me")).toEqual({
      status: "open",
      whatRan: "task",
      by: "me",
    });
  });

  test("reads a schedule's history and the Scheduled facet", () => {
    const nav = parse(`status=all&by=scheduled&schedule=${scheduleId}`);
    expect(nav).toEqual({
      status: "all",
      by: "scheduled",
      schedule: scheduleId,
    });
    expect(runsQueryOf(nav)).toEqual({
      status: "all",
      startedBy: "scheduled",
      scheduleId,
    });
    expect(parse("schedule=nope")).toEqual({ status: "open" });
  });

  test("an old `whatRan=chat` link reads as `task`", () => {
    expect(parse("whatRan=chat")).toEqual({ status: "open", whatRan: "task" });
  });

  test("`at` needs a `whatRan`", () => {
    expect(parse("at=review")).toEqual({ status: "open" });
  });
});

describe("patchRunsNav and runsNavHref", () => {
  test("changing what ran drops the node", () => {
    const nav = parse(`whatRan=${pipelineId}&at=review`);
    expect(patchRunsNav(nav, { whatRan: "task" })).toEqual({
      status: "open",
      whatRan: "task",
    });
  });

  test("undefined clears a key", () => {
    expect(patchRunsNav(parse("q=x&by=me"), { q: undefined })).toEqual({
      status: "open",
      by: "me",
    });
  });

  test("leaves the default status out of the URL", () => {
    expect(runsNavHref("/a/b/runs", { status: "open" })).toBe("/a/b/runs");
    expect(runsNavHref("/a/b/runs", { status: "all", q: "a b" })).toBe(
      "/a/b/runs?status=all&q=a+b",
    );
  });
});

describe("runsQueryKey", () => {
  test("is order-independent and round-trips", () => {
    const a = runsQueryKey({ status: "all", q: "x", startedBy: "me" });
    const b = runsQueryKey({ startedBy: "me", status: "all", q: "x" });
    expect(a).toBe(b);
    expect(runsQueryFromKey(a)).toEqual({
      status: "all",
      q: "x",
      startedBy: "me",
    });
  });
});
