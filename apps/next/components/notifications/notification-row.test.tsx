import { afterEach, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  AnyJsonObject,
  UserNotificationContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

installDom({ pretendToBeVisual: true });

const { cleanup, render } = await import("@testing-library/react");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");
const { NotificationRow } = await import("./notification-row");

const projectId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");

const waiting = (payloadJson: AnyJsonObject): UserNotificationContract => ({
  id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa962"),
  projectId,
  workItemId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901"),
  pipelineExecutionId: null,
  taskId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa961"),
  agentSessionId: null,
  recipientUserId: null,
  kind: "feedback_request",
  audience: "specific_users",
  title: "Scarn is waiting on you in Fix the bug",
  body: "I need to label the bug.",
  priority: "normal",
  source: "agent",
  status: "delivered",
  payloadJson,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
});

const renderRow = (notification: UserNotificationContract) =>
  render(
    <ProjectRouteProvider
      username="alice"
      projectSlug="demo"
      projectId={projectId}
      isMember
    >
      <NotificationRow
        notification={notification}
        projectId={projectId}
        onDismissed={() => {}}
        onResponded={() => {}}
      />
    </ProjectRouteProvider>,
  );

describe("NotificationRow", () => {
  afterEach(() => {
    cleanup();
  });

  test("a wait whose agent asks for more access says so", () => {
    const view = renderRow(
      waiting({ grantRequestId: "019e9a92-b432-73e8-9341-3519156fa963" }),
    );

    expect(
      view.getByText("Scarn is waiting on you in Fix the bug"),
    ).toBeTruthy();
    expect(view.getByText("The agent asks for more access")).toBeTruthy();
  });

  test("a plain wait doesn't", () => {
    const view = renderRow(waiting({}));

    expect(view.queryByText("The agent asks for more access")).toBeNull();
  });
});
