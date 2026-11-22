import { describe, expect, test } from "bun:test";
import {
  buildSelectionHref,
  buildStepFocusHref,
  buildStepPageHref,
  pinSelection,
  buildStepViewHref,
  parseExecutionDetailSelection,
  parseDetailsParam,
  parseFocusParam,
  parseLogFilter,
  parseRunParam,
  parseStepView,
} from "./execution-detail-params";

describe("parseDetailsParam", () => {
  const parse = (query: string) =>
    parseDetailsParam(new URLSearchParams(query));

  test("reads the visit id the drawer is open on", () => {
    expect(parse("details=visit-3")).toBe("visit-3");
  });

  test("treats an absent or empty ?details= as closed", () => {
    expect(parse("")).toBeNull();
    expect(parse("details=")).toBeNull();
  });
});

describe("parseExecutionDetailSelection", () => {
  const parse = (query: string) =>
    parseExecutionDetailSelection(new URLSearchParams(query));

  test("an absent ?step= selects the overview", () => {
    expect(parse("visit=v1")).toEqual({ kind: "overview" });
  });

  test("reads the node and, when present, the visit", () => {
    expect(parse("step=review")).toEqual({
      kind: "step",
      nodeId: "review",
      visitId: null,
    });
    expect(parse("step=review&visit=v1")).toEqual({
      kind: "step",
      nodeId: "review",
      visitId: "v1",
    });
  });
});

describe("parseStepView", () => {
  const parse = (query: string) => parseStepView(new URLSearchParams(query));

  test("parses the Logs view", () => {
    expect(parse("view=logs")).toBe("logs");
    expect(parse("view=conversation")).toBe("conversation");
  });

  test("falls back to the Conversation view", () => {
    expect(parse("")).toBe("conversation");
    expect(parse("view=agent")).toBe("conversation");
    expect(parse("view=worker")).toBe("conversation");
  });
});

describe("parseLogFilter", () => {
  const parse = (query: string) => parseLogFilter(new URLSearchParams(query));

  test("parses each stream filter", () => {
    expect(parse("filter=all")).toBe("all");
    expect(parse("filter=worker")).toBe("worker");
    expect(parse("filter=ai-server")).toBe("ai-server");
  });

  test("falls back to all", () => {
    expect(parse("")).toBe("all");
    expect(parse("filter=agent")).toBe("all");
    expect(parse("view=worker")).toBe("all");
  });
});

describe("parseRunParam", () => {
  const parse = (query: string) => parseRunParam(new URLSearchParams(query));

  test("parses a positive run number", () => {
    expect(parse("run=2")).toBe(2);
  });

  test("treats an absent or invalid ?run= as the latest run", () => {
    expect(parse("")).toBeNull();
    expect(parse("run=0")).toBeNull();
    expect(parse("run=-1")).toBeNull();
    expect(parse("run=1.5")).toBeNull();
    expect(parse("run=latest")).toBeNull();
  });
});

describe("parseFocusParam", () => {
  test("only artifacts is a focus target", () => {
    expect(parseFocusParam(new URLSearchParams("focus=artifacts"))).toBe(
      "artifacts",
    );
    expect(parseFocusParam(new URLSearchParams("focus=logs"))).toBeNull();
  });
});

describe("buildStepPageHref", () => {
  test("sets ?view=, ?filter= and ?run=", () => {
    expect(
      buildStepPageHref("/runs/1", new URLSearchParams("step=build"), {
        view: "logs",
        filter: "worker",
        run: 2,
      }),
    ).toBe("/runs/1?step=build&view=logs&filter=worker&run=2");
  });

  test("writes the defaults as absent params", () => {
    expect(
      buildStepPageHref(
        "/runs/1",
        new URLSearchParams("step=build&view=logs&filter=worker&run=2"),
        { view: "conversation", filter: "all", run: null },
      ),
    ).toBe("/runs/1?step=build");
  });

  test("leaves params the patch omits alone", () => {
    expect(
      buildStepPageHref(
        "/runs/1",
        new URLSearchParams("step=build&view=logs&filter=worker&details=1"),
        { run: 3 },
      ),
    ).toBe("/runs/1?step=build&view=logs&filter=worker&details=1&run=3");
  });

  test("sets ?details= and spends a ?focus= deep link", () => {
    expect(
      buildStepPageHref(
        "/runs/1",
        new URLSearchParams("step=build&focus=artifacts"),
        { details: "visit-2" },
      ),
    ).toBe("/runs/1?step=build&details=visit-2");
  });

  test("closing the drawer clears ?details=", () => {
    expect(
      buildStepPageHref(
        "/runs/1",
        new URLSearchParams("step=build&details=2"),
        {
          details: null,
        },
      ),
    ).toBe("/runs/1?step=build");
  });
});

describe("buildSelectionHref", () => {
  test("selecting a step clears the step page's params", () => {
    expect(
      buildSelectionHref(
        "/runs/1",
        new URLSearchParams(
          "step=build&view=logs&filter=worker&run=1&details=2&focus=artifacts",
        ),
        { kind: "step", nodeId: "test", visitId: null },
      ),
    ).toBe("/runs/1?step=test");
  });

  test("selecting a visit sets ?visit=, and selecting the node alone clears it", () => {
    expect(
      buildSelectionHref("/runs/1", new URLSearchParams("step=build"), {
        kind: "step",
        nodeId: "test",
        visitId: "v2",
      }),
    ).toBe("/runs/1?step=test&visit=v2");
    expect(
      buildSelectionHref("/runs/1", new URLSearchParams("step=test&visit=v2"), {
        kind: "step",
        nodeId: "test",
        visitId: null,
      }),
    ).toBe("/runs/1?step=test");
  });

  test("selecting the overview clears ?details=", () => {
    expect(
      buildSelectionHref(
        "/runs/1",
        new URLSearchParams("step=build&visit=v1&details=v1"),
        { kind: "overview" },
      ),
    ).toBe("/runs/1");
  });
});

describe("buildStepViewHref", () => {
  test("links a step's Conversation view without any view param", () => {
    expect(
      buildStepViewHref(
        "/runs/1",
        new URLSearchParams("from=work-item%3Ax&view=logs&run=2"),
        "reproduce",
        "conversation",
      ),
    ).toBe("/runs/1?from=work-item%3Ax&step=reproduce");
  });

  test("links a step's Logs view", () => {
    expect(
      buildStepViewHref("/runs/1", new URLSearchParams(), "reproduce", "logs"),
    ).toBe("/runs/1?step=reproduce&view=logs");
  });
});

describe("buildStepFocusHref", () => {
  test("links a step scrolled to Artifacts", () => {
    expect(
      buildStepFocusHref(
        "/runs/1",
        new URLSearchParams(),
        "reproduce",
        "artifacts",
      ),
    ).toBe("/runs/1?step=reproduce&focus=artifacts");
  });
});

describe("pinSelection", () => {
  const pin = (query: string, visitId: string | null) =>
    pinSelection(new URLSearchParams(query), {
      kind: "step",
      nodeId: "approve",
      visitId,
    }).toString();

  test("writes the landed step and visit, keeping the page's params", () => {
    expect(pin("from=work-item:1&view=logs", null)).toBe(
      "from=work-item%3A1&view=logs&step=approve",
    );
    expect(pin("", "v2")).toBe("step=approve&visit=v2");
  });

  test("leaves an explicit ?step= alone", () => {
    expect(pin("step=review", "v2")).toBe("step=review");
  });

  test("leaves the overview selection alone", () => {
    expect(
      pinSelection(new URLSearchParams("details=run"), {
        kind: "overview",
      }).toString(),
    ).toBe("details=run");
  });
});
