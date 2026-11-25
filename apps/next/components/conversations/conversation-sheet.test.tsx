import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  api,
  cancelTaskMock,
  continueMock,
  conversationId,
  doneMock,
  resetApi,
} from "./conversation-panel-test-support";

const pushes: string[] = [];
void mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      pushes.push(href);
    },
    replace: () => {},
    back: () => {},
    refresh: () => {},
    prefetch: () => Promise.resolve(),
  }),
  usePathname: () => "/tester/demo/work-items/1",
  useSearchParams: () => new URLSearchParams(),
}));

const media = { narrow: false };
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList =>
    ({
      addEventListener() {},
      addListener() {},
      dispatchEvent() {
        return false;
      },
      matches: media.narrow && query.includes("max-width"),
      media: query,
      onchange: null,
      removeEventListener() {},
      removeListener() {},
    }) as MediaQueryList,
});

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ConversationSheet } = await import("./conversation-sheet");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const ALL = ["comments:write", "executions:write"];
const taskId = "019e9a92-b432-73e8-9341-3519156fa6aa";

const renderSheet = ({
  permissions = ALL,
  withTask = true,
}: { permissions?: string[]; withTask?: boolean } = {}) => {
  const onClose = mock(() => {});
  const onChanged = mock(() => {});
  const view = render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId="019e709b-574f-742c-8fda-00a1bcc71b9d"
      isMember
      permissions={permissions}
    >
      <ConversationSheet
        conversationId={conversationId}
        agentName="Grill"
        workItemTitle="Add SSO"
        taskId={withTask ? taskId : null}
        onClose={onClose}
        onChanged={onChanged}
      />
    </ProjectRouteProvider>,
  );
  return { view, onClose, onChanged };
};

const loaded = async (view: ReturnType<typeof render>) => {
  await waitFor(() => {
    expect(view.getByText("SAML only, or SAML and OIDC?")).toBeTruthy();
  });
};

const openMenu = (view: ReturnType<typeof render>) => {
  fireEvent.click(view.getByRole("button", { name: "Conversation actions" }));
};

const menuItemNames = (view: ReturnType<typeof render>) =>
  view.queryAllByRole("menuitem").map((item) => item.textContent);

describe("ConversationSheet", () => {
  beforeEach(() => {
    resetApi();
    media.narrow = false;
    pushes.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the thread, the composer and the header", async () => {
    const { view } = renderSheet();
    await loaded(view);

    expect(view.getByLabelText("Message Grill")).toBeTruthy();
    expect(view.getByText("Add SSO")).toBeTruthy();
    expect(view.getByText("Waiting on you")).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Continue without reply" }),
    ).toBeNull();
  });

  test("the ⋯ menu lists the actions, Open run and Stop for a full member", async () => {
    api.endsWith = "conversation";
    const { view, onChanged } = renderSheet();
    await loaded(view);

    openMenu(view);
    expect(menuItemNames(view)).toEqual([
      "Done",
      "Continue without reply",
      "Open run",
      "Stop",
    ]);
    expect(
      view.getByRole("menuitem", { name: "Open run" }).getAttribute("href"),
    ).toBe(
      "/tester/demo/runs/019e9a92-b432-73e8-9341-3519156fa696?step=grill&visit=019e9a92-b432-73e8-9341-3519156fa698",
    );

    fireEvent.click(view.getByRole("menuitem", { name: "Done" }));
    await waitFor(() => {
      expect(doneMock).toHaveBeenCalledTimes(1);
      expect(onChanged).toHaveBeenCalled();
    });
  });

  test("Ask it to finish shows on a findings step; Stop cancels the Task", async () => {
    const { view } = renderSheet();
    await loaded(view);

    openMenu(view);
    expect(menuItemNames(view)).toEqual([
      "Ask it to finish",
      "Continue without reply",
      "Open run",
      "Stop",
    ]);
    fireEvent.click(view.getByRole("menuitem", { name: "Stop" }));
    await waitFor(() => {
      expect(cancelTaskMock).toHaveBeenCalledWith(taskId);
    });
  });

  test("the ⋯ menu respects permissions", async () => {
    const { view } = renderSheet({ permissions: ["comments:write"] });
    await loaded(view);

    openMenu(view);
    expect(menuItemNames(view)).toEqual(["Ask it to finish", "Open run"]);
    expect(continueMock).not.toHaveBeenCalled();
  });

  test("without a Task there is no Stop", async () => {
    const { view } = renderSheet({ withTask: false });
    await loaded(view);

    openMenu(view);
    expect(menuItemNames(view)).not.toContain("Stop");
  });

  test("Show work goes to the run's logs on the step page", async () => {
    const { view } = renderSheet();
    await loaded(view);

    fireEvent.click(view.getByRole("button", { name: "Show work" }));
    expect(pushes).toEqual([
      "/tester/demo/runs/019e9a92-b432-73e8-9341-3519156fa696?step=grill&visit=019e9a92-b432-73e8-9341-3519156fa698&view=logs",
    ]);
  });

  test("close calls back", async () => {
    const { view, onClose } = renderSheet();
    await loaded(view);

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Widen" })).toBeTruthy();
  });

  test("below md it renders full width with a back arrow", async () => {
    media.narrow = true;
    const { view, onClose } = renderSheet();
    await loaded(view);

    expect(
      view.getByTestId("conversation-sheet").getAttribute("data-layout"),
    ).toBe("full");
    expect(view.queryByRole("button", { name: "Close" })).toBeNull();
    expect(view.queryByRole("button", { name: "Widen" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
