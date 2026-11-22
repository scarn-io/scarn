import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "@/tests/support/install-dom";

type PostBody = { id: string; platformKey: string; platform: string };
const post = mock((body: PostBody) =>
  Promise.resolve({ data: { id: body.id }, error: null }),
);
const push = mock<(href: string) => void>(() => {});

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({ api: { "work-items": { post } } }),
}));

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push, refresh: () => {} }),
}));

const { CreateWorkItemForm } = await import("./create-work-item-form");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("CreateWorkItemForm", () => {
  beforeEach(() => {
    const dom = installDom({ url: "https://app.scarn.io/" });
    Object.assign(globalThis, {
      FormData: dom.window.FormData,
      HTMLFormElement: dom.window.HTMLFormElement,
      requestAnimationFrame: (cb: FrameRequestCallback) =>
        setTimeout(() => {
          cb(Date.now());
        }, 0) as unknown as number,
      cancelAnimationFrame: (handle: number) => {
        clearTimeout(handle);
      },
    });
    post.mockClear();
    push.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("sends a client-made UUID v7 as the id and manual-<id> as the platformKey", async () => {
    const view = render(
      <ProjectRouteProvider
        username="tester"
        projectSlug="demo"
        projectId={PROJECT_ID}
        isMember
      >
        <CreateWorkItemForm projectId={PROJECT_ID} />
      </ProjectRouteProvider>,
    );

    fireEvent.change(view.getByLabelText(/Add a title/), {
      target: { value: "New item" },
    });
    fireEvent.change(view.getByLabelText(/Add a description/), {
      target: { value: "Its description" },
    });
    fireEvent.click(view.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(push).toHaveBeenCalled();
    });
    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0]?.[0];
    expect(body?.id).toMatch(UUID_V7);
    expect(body?.platformKey).toBe(`manual-${String(body?.id)}`);
    expect(body?.platform).toBe("scarn");
    expect(push).toHaveBeenCalledWith(
      `/tester/demo/work-items/${String(body?.id)}`,
    );
  });
});
