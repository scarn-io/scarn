import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentTaskId,
  api,
  buildConversation,
  getMock,
  grantRequests,
  resetApi,
} from "./conversation-panel-test-support";

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ConversationMessageBox, ConversationPanel } =
  await import("./conversation-panel");
const { useConversation } = await import("./use-conversation");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const grantRequestId = "019e9a92-b432-73e8-9341-3519156fa7b1";

const asking = () => {
  const conversation = buildConversation("waiting_for_person", "findings");
  return {
    ...conversation,
    messages: [
      {
        id: "019e9a92-b432-73e8-9341-3519156fa734",
        authorKind: "agent",
        authorName: null,
        taskRunId: agentTaskId,
        grantRequestId,
        body: "I need to comment on the item.",
        createdAt: "2026-06-05T12:03:00.000Z",
      },
    ],
  };
};

const pendingRequest = {
  id: grantRequestId,
  taskId: agentTaskId,
  taskRunId: agentTaskId,
  reason: "To post what I found.",
  requested: [{ resource: "workItem", action: "comment", scope: "self" }],
  status: "pending",
  approved: null,
  note: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: "2026-06-05T12:03:00.000Z",
};

function Harness() {
  const data = useConversation("019e9a92-b432-73e8-9341-3519156fa730", {});
  return (
    <>
      <ConversationPanel data={data} onShowWork={() => {}} agentName="Grill" />
      <ConversationMessageBox data={data} agentName="Grill" />
    </>
  );
}

const renderPanel = () =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId="019e709b-574f-742c-8fda-00a1bcc71b9d"
      isMember
      permissions={["comments:write", "executions:write", "work-items:write"]}
    >
      <Harness />
    </ProjectRouteProvider>,
  );

describe("ConversationPanel with a grant request", () => {
  beforeEach(() => {
    resetApi();
    grantRequests.list = [pendingRequest];
    getMock.mockImplementation(() =>
      Promise.resolve({ data: asking(), error: null }),
    );
  });

  afterEach(() => {
    cleanup();
    getMock.mockImplementation(() =>
      Promise.resolve({
        data: buildConversation(api.status, api.endsWith),
        error: null,
      }),
    );
  });

  test("the agent message carries the card, and approving posts the decision", async () => {
    const view = renderPanel();

    expect(
      await view.findByText("The agent is asking for more access"),
    ).toBeTruthy();
    expect(view.getByText("To post what I found.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Approve selected" }));

    await waitFor(() => {
      expect(grantRequests.decisions).toEqual([
        {
          id: grantRequestId,
          body: {
            approved: [
              { resource: "workItem", action: "comment", scope: "self" },
            ],
          },
        },
      ]);
    });
  });

  test("while the request is pending the reply box says a reply leaves it unanswered", async () => {
    const view = renderPanel();

    expect(
      await view.findByText(
        "Grill is asking for more access — a reply leaves that request unanswered",
      ),
    ).toBeTruthy();
  });
});
