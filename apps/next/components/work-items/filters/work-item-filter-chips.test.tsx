import { afterEach, describe, expect, mock, test } from "bun:test";
import type { WorkItemFilter } from "./work-item-filter-model";
import { installDom } from "@/tests/support/install-dom";

/**
 * The DOM globals are installed at module scope, before React is imported,
 * because `react-dom` decides at import time whether the browser supports the
 * `input` event. With no `window` in scope it falls back to an IE-era
 * `attachEvent` polyfill that throws on every keystroke against a text input —
 * which is exactly what this suite types into.
 */
installDom({ url: "https://app.scarn.io/" });

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { WorkItemFilterChips } = await import("./work-item-filter-chips");

const noop = () => {
  // A callback this particular test does not assert on.
};

const valueOf = (element: HTMLElement): string =>
  (element as HTMLInputElement).value;

describe("WorkItemFilterChips", () => {
  afterEach(() => {
    cleanup();
  });

  const renderChips = (
    filters: WorkItemFilter[],
    overrides: {
      searchText?: string;
      onCommitText?: (value: string) => void;
      onRemoveFilter?: (filter: WorkItemFilter) => void;
      onClearFilters?: () => void;
    } = {},
  ) =>
    render(
      <WorkItemFilterChips
        filters={filters}
        searchText={overrides.searchText ?? ""}
        onCommitText={overrides.onCommitText ?? noop}
        onRemoveFilter={overrides.onRemoveFilter ?? noop}
        onClearFilters={overrides.onClearFilters ?? noop}
      />,
    );

  test("keeps the search input's existing accessible name", () => {
    const view = renderChips([]);

    expect(view.getByLabelText("Search work items")).toBeTruthy();
  });

  test("renders a clause as a chip with a labelled remove button", () => {
    const view = renderChips([{ kind: "field", key: "priority", value: "P1" }]);

    expect(view.getByText("priority: P1")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Remove priority: P1 filter" }),
    ).toBeTruthy();
  });

  test("the remove button reports the clause it removes", () => {
    const filter: WorkItemFilter = { kind: "awaitingApproval" };
    const onRemoveFilter = mock(() => {
      // Recorded by the mock.
    });
    const view = renderChips([filter], { onRemoveFilter });

    fireEvent.click(
      view.getByRole("button", { name: "Remove awaiting approval filter" }),
    );

    expect(onRemoveFilter).toHaveBeenCalledWith(filter);
  });

  test("shows the free text in the input rather than as a chip", () => {
    const view = renderChips([{ kind: "text", value: "payment retry" }], {
      searchText: "payment retry",
    });

    expect(valueOf(view.getByLabelText("Search work items"))).toBe(
      "payment retry",
    );
    expect(view.queryByRole("button", { name: /Remove .* filter/ })).toBeNull();
  });

  test("Enter commits whatever the box already holds", () => {
    const onCommitText = mock(() => {
      // Recorded by the mock.
    });
    const view = renderChips([{ kind: "text", value: "payment retry" }], {
      searchText: "payment retry",
      onCommitText,
    });

    fireEvent.keyDown(view.getByLabelText("Search work items"), {
      key: "Enter",
    });

    expect(onCommitText).toHaveBeenCalledWith("payment retry");
  });

  test("Backspace on an empty input removes the last chip", () => {
    const filters: WorkItemFilter[] = [
      { kind: "field", key: "priority", value: "P1" },
      { kind: "field", key: "env", value: "prod" },
    ];
    const onRemoveFilter = mock(() => {
      // Recorded by the mock.
    });
    const view = renderChips(filters, { onRemoveFilter });

    fireEvent.keyDown(view.getByLabelText("Search work items"), {
      key: "Backspace",
    });

    expect(onRemoveFilter).toHaveBeenCalledWith(filters[1]);
  });

  test("Backspace with text still in the box leaves the chips alone", () => {
    const onRemoveFilter = mock(() => {
      // Recorded by the mock.
    });
    const view = renderChips(
      [
        { kind: "text", value: "pay" },
        { kind: "field", key: "env", value: "prod" },
      ],
      { searchText: "pay", onRemoveFilter },
    );

    fireEvent.keyDown(view.getByLabelText("Search work items"), {
      key: "Backspace",
    });

    expect(onRemoveFilter).not.toHaveBeenCalled();
  });

  test("reports a request to clear everything", () => {
    const onClearFilters = mock(() => {
      // Recorded by the mock.
    });
    const view = renderChips([{ kind: "awaitingApproval" }], {
      onClearFilters,
    });

    fireEvent.click(view.getByRole("button", { name: "Clear filters" }));

    expect(onClearFilters).toHaveBeenCalled();
  });

  test("offers Clear filters only while something is filtered", () => {
    expect(
      renderChips([]).queryByRole("button", { name: "Clear filters" }),
    ).toBeNull();
    cleanup();

    expect(
      renderChips([{ kind: "awaitingApproval" }]).getByRole("button", {
        name: "Clear filters",
      }),
    ).toBeTruthy();
  });

  test("follows the URL when the committed text changes underneath it", () => {
    const view = renderChips([{ kind: "text", value: "payment" }], {
      searchText: "payment",
    });

    expect(valueOf(view.getByLabelText("Search work items"))).toBe("payment");

    view.rerender(
      <WorkItemFilterChips
        filters={[]}
        searchText=""
        onCommitText={noop}
        onRemoveFilter={noop}
        onClearFilters={noop}
      />,
    );

    expect(valueOf(view.getByLabelText("Search work items"))).toBe("");
  });
});
