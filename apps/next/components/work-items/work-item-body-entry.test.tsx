import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSDOM } from "jsdom";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

type PatchBody = {
  title: string;
  description: string;
  descriptionVersion: number;
};
type PatchResult = { data: WorkItemContract | null; error: object | null };
const patch = mock<(body: PatchBody) => Promise<PatchResult>>(() =>
  Promise.resolve({ data: null, error: null }),
);

const statusesGet = mock(() => Promise.resolve({ data: [], error: null }));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-items": () => ({ patch }),
      projects: () => ({ "work-item-statuses": { get: statusesGet } }),
    },
  }),
}));

const { WorkItemBodyEntry: BareWorkItemBodyEntry } =
  await import("./work-item-body-entry");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

function WorkItemBodyEntry(
  props: React.ComponentProps<typeof BareWorkItemBodyEntry>,
) {
  return (
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={props.workItem.projectId}
      isMember
    >
      <BareWorkItemBodyEntry {...props} />
    </ProjectRouteProvider>
  );
}

const buildWorkItem = (
  overrides: Partial<WorkItemContract> = {},
): WorkItemContract =>
  ({
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
    projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
    platform: "scarn",
    platformId: null,
    platformKey: "manual-1",
    url: null,
    title: "Original title",
    description: "Original description",
    descriptionVersion: 3,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    fields: {},
    createdByUserId: "01966a2c-9494-7db5-aa46-0f8f5cbbe101",
    createdByUsername: "pam-beesly",
    createdByImage: null,
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  }) as WorkItemContract;

describe("WorkItemBodyEntry", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom({ url: "https://app.scarn.io/" });

    Object.assign(globalThis, {
      // jsdom implements neither; MUI's multiline TextField (TextareaAutosize)
      // needs both to mount/unmount without throwing.
      requestAnimationFrame: (cb: FrameRequestCallback) =>
        setTimeout(() => {
          cb(Date.now());
        }, 0) as unknown as number,
      cancelAnimationFrame: (id: number) => {
        clearTimeout(id);
      },
    });

    // React 19's input polyfill calls these IE-only methods when the
    // autofocused title field takes focus.
    type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
    const element = dom.window.Element.prototype as unknown as WithIeEvents;
    element.attachEvent = () => {};
    element.detachEvent = () => {};
  });

  afterEach(() => {
    cleanup();
  });

  test("the author of a native work item sees the edit affordance", () => {
    const view = render(
      <WorkItemBodyEntry
        workItem={buildWorkItem()}
        canEdit
        onChanged={mock(() => {})}
      />,
    );

    expect(view.getByRole("button", { name: "Edit post" })).toBeTruthy();
  });

  test("a non-author or synced work item shows no edit affordance", () => {
    const view = render(
      <WorkItemBodyEntry
        workItem={buildWorkItem({ platform: "github" })}
        canEdit={false}
        onChanged={mock(() => {})}
      />,
    );

    expect(view.queryByRole("button", { name: "Edit post" })).toBeNull();
  });

  test("clicking edit reveals title/description fields and a save/cancel pair, and cancel restores read mode", () => {
    const workItem = buildWorkItem();
    const view = render(
      <WorkItemBodyEntry
        workItem={workItem}
        canEdit
        onChanged={mock(() => {})}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Edit post" }));

    const titleField = view.getByLabelText("Title") as HTMLInputElement;
    const descriptionField = view.getByLabelText(
      "Description",
    ) as HTMLTextAreaElement;
    expect(titleField.value).toBe(workItem.title);
    expect(descriptionField.value).toBe(workItem.description);
    expect(view.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));

    expect(view.queryByLabelText("Title")).toBeNull();
    expect(view.getByText(workItem.description)).toBeTruthy();
    expect(view.getByRole("button", { name: "Edit post" })).toBeTruthy();
  });

  test("a save names the loaded version, and a conflict asks for a reload", async () => {
    patch.mockImplementationOnce(() =>
      Promise.resolve({
        data: null,
        error: {
          status: 409,
          value: {
            status: 409,
            code: "WORK_ITEM_DESCRIPTION_CONFLICT",
            detail: "Work item changed; read it again",
          },
        },
      }),
    );
    const onChanged = mock(() => {});
    const view = render(
      <WorkItemBodyEntry
        workItem={buildWorkItem()}
        canEdit
        onChanged={onChanged}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Edit post" }));
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        view.getByText("Changed since you opened it. Reload"),
      ).toBeTruthy();
    });
    expect(patch).toHaveBeenLastCalledWith({
      title: "Original title",
      description: "Original description",
      descriptionVersion: 3,
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(view.getByLabelText("Description")).toBeTruthy();
  });
  test("renders the description as Markdown, dropping raw HTML", () => {
    const view = render(
      <WorkItemBodyEntry
        workItem={buildWorkItem({
          description:
            "## Plan\n\n- **first** step\n- `second`\n\n<script>alert(1)</script>",
        })}
        canEdit={false}
        onChanged={mock(() => {})}
      />,
    );

    expect(view.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(view.getAllByRole("listitem")).toHaveLength(2);
    expect(view.getByText("first").tagName).toBe("STRONG");
    expect(view.getByText("second").tagName).toBe("CODE");
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.textContent).not.toContain("alert(1)");
  });
});
