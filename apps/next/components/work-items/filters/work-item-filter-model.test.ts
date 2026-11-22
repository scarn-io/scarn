import { describe, expect, test } from "bun:test";
import {
  activeLabels,
  applyFilters,
  describeFilter,
  parseWorkItemFilters,
  singleValue,
  withLabelAdded,
  withLabelToggled,
  withSingleValue,
  type WorkItemFilter,
} from "./work-item-filter-model";

const MEMBER_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";

const parse = (query: string): WorkItemFilter[] =>
  parseWorkItemFilters(new URLSearchParams(query));

const apply = (query: string, filters: WorkItemFilter[]): string =>
  applyFilters(new URLSearchParams(query), filters).toString();

/**
 * A URL is the only place a filter lives, so every clause has to survive the
 * round trip unchanged — otherwise a shared link means something different to
 * the person who opens it.
 */
describe("parseWorkItemFilters / applyFilters round trip", () => {
  const cases: { name: string; query: string; filters: WorkItemFilter[] }[] = [
    {
      name: "free text",
      query: "q=payment+retry",
      filters: [{ kind: "text", value: "payment retry" }],
    },
    {
      name: "field filter",
      query: "f.priority=P1",
      filters: [{ kind: "field", key: "priority", value: "P1" }],
    },
    {
      name: "field filter with an encoded key",
      query: `f.${encodeURIComponent("pct done")}=50`,
      filters: [{ kind: "field", key: "pct done", value: "50" }],
    },
    {
      name: "relative updated-after bound",
      query: "updatedAfter=7d",
      filters: [{ kind: "updated", after: { kind: "relative", hours: 168 } }],
    },
    {
      name: "relative updated-before bound",
      query: "updatedBefore=30d",
      filters: [{ kind: "updated", before: { kind: "relative", hours: 720 } }],
    },
    {
      name: "an absolute date range",
      query: "updatedAfter=2026-01-01&updatedBefore=2026-02-01",
      filters: [
        {
          kind: "updated",
          after: { kind: "absolute", date: "2026-01-01" },
          before: { kind: "absolute", date: "2026-02-01" },
        },
      ],
    },
    {
      name: "awaiting approval",
      query: "awaitingApproval=true",
      filters: [{ kind: "awaitingApproval" }],
    },
    {
      name: "assignee: me",
      query: "assignee=me",
      filters: [{ kind: "assignee", value: "me" }],
    },
    {
      name: "assignee: none",
      query: "assignee=none",
      filters: [{ kind: "assignee", value: "none" }],
    },
    {
      name: "assignee: a member",
      query: `assignee=${MEMBER_ID}`,
      filters: [{ kind: "assignee", value: MEMBER_ID }],
    },
    {
      name: "agent",
      query: "agent=waiting_on_me",
      filters: [{ kind: "agent", value: "waiting_on_me" }],
    },
    {
      name: "status",
      query: "status=failed",
      filters: [{ kind: "status", value: "failed" }],
    },
    {
      name: "status: active",
      query: "status=active",
      filters: [{ kind: "status", value: "active" }],
    },
    {
      name: "platform",
      query: "platform=github",
      filters: [{ kind: "platform", value: "github" }],
    },
    {
      name: "labels",
      query: "labels=bug,Needs+Triage",
      filters: [
        { kind: "label", value: "bug" },
        { kind: "label", value: "Needs Triage" },
      ],
    },
  ];

  for (const { name, query, filters } of cases) {
    test(`round-trips ${name}`, () => {
      expect(parse(query)).toEqual(filters);
      expect(parse(apply("", filters))).toEqual(filters);
    });
  }

  test("round-trips every clause kind at once", () => {
    const filters: WorkItemFilter[] = [
      { kind: "text", value: "payment retry" },
      { kind: "field", key: "priority", value: "P1" },
      { kind: "field", key: "env", value: "prod" },
      { kind: "label", value: "bug" },
      { kind: "label", value: "ui" },
      {
        kind: "updated",
        after: { kind: "relative", hours: 168 },
        before: { kind: "absolute", date: "2026-02-01" },
      },
      { kind: "awaitingApproval" },
      { kind: "assignee", value: "me" },
      { kind: "agent", value: "running" },
      { kind: "status", value: "failed" },
      { kind: "platform", value: "jira" },
    ];

    expect(parse(apply("", filters))).toEqual(filters);
  });

  test("normalises an hour bound that divides into whole days", () => {
    const applied = apply("", [
      { kind: "updated", after: { kind: "relative", hours: 48 } },
    ]);

    expect(applied).toBe("updatedAfter=2d");
  });

  test("keeps a sub-day bound in hours", () => {
    const applied = apply("", [
      { kind: "updated", after: { kind: "relative", hours: 6 } },
    ]);

    expect(applied).toBe("updatedAfter=6h");
  });

  test("reads clauses in a stable order regardless of param order", () => {
    const forwards = parse(
      "q=hi&f.env=prod&awaitingApproval=true&platform=github",
    );
    const backwards = parse(
      "platform=github&awaitingApproval=true&f.env=prod&q=hi",
    );

    expect(backwards).toEqual(forwards);
  });
});

/**
 * A URL with one junk param still has to render the rest of the query, so
 * parsing is total: it skips what it cannot read rather than throwing.
 */
describe("parseWorkItemFilters tolerance", () => {
  const malformed = [
    "updatedAfter=yesterday",
    "updatedAfter=2026-02-31",
    "updatedAfter=2026-13-01",
    "updatedAfter=0d",
    "updatedBefore=7w",
    "awaitingApproval=false",
    "awaitingApproval=1",
    "awaitingApproval=",
    "platform=slack",
    "q=",
    "q=+++",
    "status=",
    "status=running",
    "status=queued",
    "agent=",
    "agent=waiting",
    "assignee=",
    "assignee=someone",
    "f.=orphan",
    "f.priority=",
    "f.%E0%A4%A=broken",
    "labels=",
    "labels=,+,",
  ];

  for (const query of malformed) {
    test(`skips \`${query}\` without throwing`, () => {
      expect(() => parse(query)).not.toThrow();
      expect(parse(query)).toEqual([]);
    });
  }

  test("keeps the readable clauses alongside a malformed one", () => {
    expect(
      parse("f.env=prod&updatedAfter=nonsense&awaitingApproval=true"),
    ).toEqual([
      { kind: "field", key: "env", value: "prod" },
      { kind: "awaitingApproval" },
    ]);
  });

  test("trims surrounding whitespace off free text", () => {
    expect(parse("q=++spaced++")).toEqual([{ kind: "text", value: "spaced" }]);
  });

  test("drops blank and repeated labels, keeping case", () => {
    expect(parse("labels=bug,,Bug,bug")).toEqual([
      { kind: "label", value: "bug" },
      { kind: "label", value: "Bug" },
    ]);
  });
});

describe("withLabelToggled / activeLabels", () => {
  test("adds a label that is not yet a clause", () => {
    const filters = withLabelToggled([{ kind: "label", value: "bug" }], "ui");

    expect(activeLabels(filters)).toEqual(["bug", "ui"]);
    expect(apply("", filters)).toBe("labels=bug%2Cui");
  });

  test("removes a label that is already a clause", () => {
    const filters = withLabelToggled(
      [
        { kind: "text", value: "hi" },
        { kind: "label", value: "bug" },
      ],
      "bug",
    );

    expect(filters).toEqual([{ kind: "text", value: "hi" }]);
  });

  test("withLabelAdded keeps a label that is already a clause", () => {
    const filters: WorkItemFilter[] = [{ kind: "label", value: "bug" }];

    expect(withLabelAdded(filters, "bug")).toBe(filters);
    expect(activeLabels(withLabelAdded(filters, "ui"))).toEqual(["bug", "ui"]);
  });
});

describe("applyFilters", () => {
  test("removes a clause that is no longer in the set", () => {
    const applied = apply("q=hi&f.env=prod&awaitingApproval=true", [
      { kind: "field", key: "env", value: "prod" },
    ]);

    expect(applied).toBe("f.env=prod");
  });

  test("clears every owned param when the set is empty", () => {
    const applied = apply(
      "q=hi&f.env=prod&labels=bug&updatedAfter=7d&updatedBefore=30d&awaitingApproval=true&assignee=me&agent=failed&status=failed&platform=github",
      [],
    );

    expect(applied).toBe("");
  });

  test("clears `page`", () => {
    const applied = apply("page=4&f.env=prod", [
      { kind: "field", key: "env", value: "prod" },
    ]);

    expect(applied).toBe("f.env=prod");
  });

  test("leaves `pageSize` and the `sort` param alone", () => {
    const applied = apply("pageSize=50&sort=created-desc&page=3", [
      { kind: "text", value: "hi" },
    ]);

    expect(applied).toBe("pageSize=50&sort=created-desc&q=hi");
  });

  test("replaces a field filter's value rather than accumulating one", () => {
    const applied = apply("f.env=dev", [
      { kind: "field", key: "env", value: "prod" },
    ]);

    expect(applied).toBe("f.env=prod");
  });

  test("does not mutate the params it is given", () => {
    const original = new URLSearchParams("q=hi&page=4");
    applyFilters(original, []);

    expect(original.toString()).toBe("q=hi&page=4");
  });

  test("drops a blank clause instead of writing an empty param", () => {
    const applied = apply("", [
      { kind: "text", value: "   " },
      { kind: "field", key: "env", value: "" },
      { kind: "updated" },
    ]);

    expect(applied).toBe("");
  });
});

describe("describeFilter", () => {
  const label = (filter: WorkItemFilter) => describeFilter(filter).label;

  test("tones dynamic field filters as project-scoped", () => {
    expect(
      describeFilter({ kind: "field", key: "priority", value: "P1" }),
    ).toEqual({ label: "priority: P1", tone: "project" });
  });

  test("tones every other clause kind as universal", () => {
    const universal: WorkItemFilter[] = [
      { kind: "text", value: "payment" },
      { kind: "updated", after: { kind: "relative", hours: 168 } },
      { kind: "awaitingApproval" },
      { kind: "assignee", value: "me" },
      { kind: "agent", value: "failed" },
      { kind: "status", value: "failed" },
      { kind: "platform", value: "github" },
      { kind: "label", value: "bug" },
    ];

    for (const filter of universal) {
      expect(describeFilter(filter).tone).toBe("universal");
    }
  });

  test("labels updated bounds in the menu's own words", () => {
    expect(
      label({ kind: "updated", after: { kind: "relative", hours: 24 } }),
    ).toBe("updated: last 24 hours");
    expect(
      label({ kind: "updated", after: { kind: "relative", hours: 168 } }),
    ).toBe("updated: last 7 days");
    expect(
      label({ kind: "updated", before: { kind: "relative", hours: 720 } }),
    ).toBe("updated: older than 30 days");
    expect(
      label({
        kind: "updated",
        after: { kind: "absolute", date: "2026-01-01" },
      }),
    ).toBe("updated: after 2026-01-01");
    expect(
      label({
        kind: "updated",
        after: { kind: "absolute", date: "2026-01-01" },
        before: { kind: "absolute", date: "2026-02-01" },
      }),
    ).toBe("updated: 2026-01-01 – 2026-02-01");
  });

  test("labels the awaiting-approval clause", () => {
    expect(label({ kind: "awaitingApproval" })).toBe("awaiting approval");
  });

  test("labels a platform by its display name, not its key", () => {
    expect(label({ kind: "platform", value: "github" })).toBe(
      "platform: GitHub",
    );
  });

  test("labels assignee presets", () => {
    expect(label({ kind: "assignee", value: "me" })).toBe("assignee: mine");
    expect(label({ kind: "assignee", value: "none" })).toBe(
      "assignee: unassigned",
    );
  });

  test("names a member assignee once members are known", () => {
    const filter: WorkItemFilter = { kind: "assignee", value: MEMBER_ID };
    expect(label(filter)).toBe("assignee: a member");
    expect(
      describeFilter(filter, (userId) =>
        userId === MEMBER_ID ? "pam" : undefined,
      ).label,
    ).toBe("assignee: pam");
  });

  test("labels the agent clause in words", () => {
    expect(label({ kind: "agent", value: "waiting_on_me" })).toBe(
      "agent: waiting on you",
    );
    expect(label({ kind: "agent", value: "waiting_on_blockers" })).toBe(
      "agent: waiting on blockers",
    );
  });

  test("labels the status clause as the latest run", () => {
    expect(label({ kind: "status", value: "failed" })).toBe(
      "latest run: failed",
    );
    expect(label({ kind: "status", value: "active" })).toBe(
      "latest run: running",
    );
  });
});

describe("withSingleValue", () => {
  test("replaces an existing clause of the same kind", () => {
    expect(
      withSingleValue(
        [
          { kind: "text", value: "hi" },
          { kind: "agent", value: "running" },
        ],
        "agent",
        "failed",
      ),
    ).toEqual([
      { kind: "text", value: "hi" },
      { kind: "agent", value: "failed" },
    ]);
  });

  test("drops the clause when the value is undefined", () => {
    expect(
      withSingleValue(
        [{ kind: "assignee", value: "me" }],
        "assignee",
        undefined,
      ),
    ).toEqual([]);
  });

  test("reads a single value back", () => {
    expect(singleValue([{ kind: "platform", value: "jira" }], "platform")).toBe(
      "jira",
    );
    expect(singleValue([], "status")).toBeUndefined();
  });
});
