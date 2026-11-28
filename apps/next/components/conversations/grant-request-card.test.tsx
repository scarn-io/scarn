import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { Grant } from "@scarn/core/tasks/task/domain/grants";
import { installDom } from "@/tests/support/install-dom";
import type { GrantRequest } from "./grant-request-api";

installDom({ pretendToBeVisual: true });
Object.assign(globalThis, {
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => {
      cb(Date.now());
    }, 0),
  cancelAnimationFrame: (id: number) => {
    clearTimeout(id);
  },
});

const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { GrantRequestCard } = await import("./grant-request-card");
const { pendingGrantRequestId } = await import("./grant-request-api");

const readChildren: Grant = {
  resource: "workItem",
  action: "read",
  scope: "children",
};
const labelSelf: Grant = {
  resource: "workItem",
  action: "label",
  scope: "self",
  labels: ["bug", "triage"],
};
const commentSelf: Grant = {
  resource: "workItem",
  action: "comment",
  scope: "self",
};

const request = (overrides: Partial<GrantRequest> = {}): GrantRequest => ({
  id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa7b1"),
  taskId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
  taskRunId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa811"),
  reason: "I need to label the bug I found.",
  requested: [readChildren, labelSelf, commentSelf],
  status: "pending",
  approved: null,
  note: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  ...overrides,
});

const renderCard = ({
  grantRequest = request(),
  canWriteExecutions = true,
  canWriteWorkItems = true,
  decidedBy = null as string | null,
} = {}) => {
  const onDecide = mock((approved: Grant[], note: string) => {
    void approved;
    void note;
    return Promise.resolve({ ok: true as const });
  });
  const view = render(
    <GrantRequestCard
      request={grantRequest}
      decidedBy={decidedBy}
      canWriteExecutions={canWriteExecutions}
      canWriteWorkItems={canWriteWorkItems}
      onDecide={onDecide}
    />,
  );
  return { view, onDecide };
};

const chip = (view: ReturnType<typeof render>, label: string) =>
  [...view.container.querySelectorAll(".MuiChip-root")].find(
    (element) => element.textContent === label,
  ) as HTMLElement;

const checkbox = (view: ReturnType<typeof render>, name: RegExp) =>
  view.getByRole("checkbox", { name });

describe("GrantRequestCard", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows the reason and every requested grant, checked, as its sentence", () => {
    const { view } = renderCard();

    expect(view.getByText("The agent is asking for more access")).toBeTruthy();
    expect(view.getByText("I need to label the bug I found.")).toBeTruthy();
    const boxes = view.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true]);
    expect(checkbox(view, /^Read its child work items\.$/)).toBeTruthy();
    expect(
      checkbox(
        view,
        /^Add or remove labels on your work item, with the labels bug, triage\.$/,
      ),
    ).toBeTruthy();
  });

  test("approves only the checked grants, with removed labels left out, and the note", async () => {
    const { view, onDecide } = renderCard();

    fireEvent.click(checkbox(view, /^Comment on your work item/));
    fireEvent.click(
      chip(view, "bug").querySelector(".MuiChip-deleteIcon") as Element,
    );
    expect(checkbox(view, /with the label triage\.$/)).toBeTruthy();
    fireEvent.change(view.getByLabelText("Note for the agent (optional)"), {
      target: { value: "Only triage, please" },
    });
    fireEvent.click(view.getByRole("button", { name: "Approve selected" }));

    await waitFor(() => {
      expect(onDecide).toHaveBeenCalledTimes(1);
    });
    expect(onDecide.mock.calls[0]).toEqual([
      [readChildren, { ...labelSelf, labels: ["triage"] }],
      "Only triage, please",
    ]);
  });

  test("the last label of a grant can't be removed", () => {
    const { view } = renderCard();
    fireEvent.click(
      chip(view, "bug").querySelector(".MuiChip-deleteIcon") as Element,
    );
    expect(chip(view, "bug")).toBeUndefined();
    expect(
      chip(view, "triage").querySelector(".MuiChip-deleteIcon"),
    ).toBeNull();
  });

  test("Deny sends no grants", async () => {
    const { view, onDecide } = renderCard();

    fireEvent.click(view.getByRole("button", { name: "Deny" }));

    await waitFor(() => {
      expect(onDecide).toHaveBeenCalledTimes(1);
    });
    expect(onDecide.mock.calls[0]?.[0]).toEqual([]);
  });

  test("Approve is disabled with nothing selected", () => {
    const { view } = renderCard();
    for (const box of view.getAllByRole("checkbox")) fireEvent.click(box);

    expect(
      (
        view.getByRole("button", {
          name: "Approve selected",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      view.getByText(
        "Select at least one grant to approve, or deny the request.",
      ),
    ).toBeTruthy();
  });

  test("without executions:write both buttons are disabled, with the reason", () => {
    const { view } = renderCard({ canWriteExecutions: false });

    for (const name of ["Approve selected", "Deny"]) {
      expect(
        (view.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(
      view.getByText("Only people who can run steps can decide on access."),
    ).toBeTruthy();
  });

  test("without work-items:write only reads can be approved", () => {
    const { view } = renderCard({ canWriteWorkItems: false });
    const approve = () =>
      view.getByRole("button", {
        name: "Approve selected",
      }) as HTMLButtonElement;

    expect(approve().disabled).toBe(true);
    expect(view.getByText(/needs permission to edit work items/)).toBeTruthy();
    fireEvent.click(checkbox(view, /^Add or remove labels/));
    fireEvent.click(checkbox(view, /^Comment on your work item/));
    expect(approve().disabled).toBe(false);
  });

  test("a decided request shows the outcome, who decided and when", () => {
    const { view } = renderCard({
      grantRequest: request({
        status: "decided",
        approved: [readChildren],
        note: "Reads only",
        decidedByUserId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa7a1"),
        decidedAt: "2026-10-01T12:05:00.000Z",
      }),
      decidedBy: "alex",
    });
    const card = within(view.getByTestId("grant-request-card"));

    expect(card.getByText("Approved 1 of 3 grants.")).toBeTruthy();
    expect(card.getByText("Read its child work items.")).toBeTruthy();
    expect(card.getByText("Note: Reads only")).toBeTruthy();
    expect(card.getByText(/^By alex · /)).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });

  test("a denied request says so", () => {
    const { view } = renderCard({
      grantRequest: request({ status: "decided", approved: [] }),
    });
    expect(view.getByText("Denied.")).toBeTruthy();
  });

  test("unanswered and withdrawn requests show as such", () => {
    const { view } = renderCard({
      grantRequest: request({ status: "unanswered" }),
    });
    expect(view.getByText(/^Left unanswered/)).toBeTruthy();
    cleanup();
    const withdrawn = renderCard({
      grantRequest: request({ status: "withdrawn" }),
    });
    expect(withdrawn.view.getByText(/^Withdrawn/)).toBeTruthy();
  });
});

describe("pendingGrantRequestId", () => {
  const id = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa7b1");
  const message = (
    authorKind: "agent" | "system",
    grantRequestId: typeof id | null,
  ) => ({
    id,
    authorKind,
    authorName: null,
    taskRunId: null,
    grantRequestId,
    body: "",
    createdAt: "2026-10-01T12:00:00.000Z",
  });

  test("the newest agent message's request, until it is decided", () => {
    expect(
      pendingGrantRequestId({
        status: "waiting_for_person",
        messages: [message("agent", id)],
      }),
    ).toBe(id);
    expect(
      pendingGrantRequestId({
        status: "waiting_for_person",
        messages: [message("agent", id), message("system", id)],
      }),
    ).toBeNull();
    expect(
      pendingGrantRequestId({
        status: "reply_pending",
        messages: [message("agent", id)],
      }),
    ).toBeNull();
  });
});
