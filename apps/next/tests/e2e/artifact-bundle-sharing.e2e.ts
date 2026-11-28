import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { DashboardPage } from "./models/pages/dashboard-page";
import { projectRoutePath } from "./models/pages/project-route";
import { createLoggedInContext } from "./support/create-logged-in-context";

const fixturesRoot = resolve(__dirname, "fixtures/artifact-bundles");

const contentTypes: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  png: "image/png",
  gif: "image/gif",
  webm: "video/webm",
};

const listFiles = (root: string, dir = root): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? listFiles(root, path)
      : [relative(root, path).split("\\").join("/")];
  });

type Bundle = { id: string; status: string };
type Share = { status: string; url: string | null; shareDeclared: boolean };

test("a step's declared bundle is auto-shared, an undeclared one is shared from the dashboard, and revoking cuts off its assets", async ({
  browser,
}) => {
  test.slow();
  const { context, page } = await createLoggedInContext(
    browser,
    `artifact-sharing-${crypto.randomUUID()}@scarn.local`,
  );
  const dashboard = new DashboardPage(page);
  const project = await dashboard.createProject({
    name: "Artifact sharing e2e",
    description: "Shareable artifact bundles",
    gitUrl: "https://github.com/example/artifact-sharing-e2e",
  });
  const projectPath = projectRoutePath(project.location);
  await page.goto(`${projectPath}/work-items/new`);
  await page.getByLabel("Add a title").fill("Ship a shareable report");
  await page.getByLabel("Add a description").fill("Report and prototype.");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/work-items\/[0-9a-f-]{36}$/);
  const workItemId = new URL(page.url()).pathname.split("/").at(-1);
  if (!workItemId) throw new Error("Expected work item ID");
  const resolved = await page.request.get("/api/projects/resolve", {
    params: {
      username: project.location.username,
      slug: project.location.projectSlug,
    },
  });
  expect(resolved.ok()).toBe(true);
  const { id: projectId } = (await resolved.json()) as { id: string };

  const api = page.request;
  const send = async <T>(
    method: "get" | "post" | "delete",
    path: string,
    data?: Record<string, unknown>,
  ): Promise<T> => {
    const response = await api[method](`/api${path}`, data ? { data } : {});
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return (await response.json()) as T;
  };

  const startTask = async (
    key: string,
    resultSchemaJson: Record<string, unknown>,
  ): Promise<{ runId: string; claimToken: string }> => {
    const step = await send<{ id: string }>("post", "/step-definitions", {
      projectId,
      key: `${key}_${crypto.randomUUID().replaceAll("-", "")}`,
      name: key,
      description: key,
      version: 1,
      kind: "user_defined",
      prompt: "Produce an artifact bundle.",
      inputSchemaJson: { type: "object" },
      resultSchemaJson,
      status: "active",
      repo: { mode: "readOnly" },
    });
    const created = await send<{ run: { id: string } }>("post", "/tasks", {
      projectId,
      workItemId,
      stepDefinitionId: step.id,
      stepDefinitionVersion: 1,
      inputJson: null,
    });
    const claims = await send<
      Array<{ task: { id: string }; claimToken: string }>
    >("post", "/task-runs/claims", {
      projectId,
      workItemId,
      workerId: `artifact-sharing-e2e-${crypto.randomUUID()}`,
      batchSize: 1,
      leaseDurationSeconds: 120,
    });
    const claim = claims.find(
      (candidate) => candidate.task.id === created.run.id,
    );
    if (!claim) throw new Error(`Expected worker claim for ${created.run.id}`);
    return { runId: created.run.id, claimToken: claim.claimToken };
  };

  const uploadBundle = async (
    request: APIRequestContext,
    run: { runId: string; claimToken: string },
    fixture: string,
    fieldPath?: string,
  ): Promise<Bundle> => {
    const { runId, claimToken } = run;
    const bundle = await send<Bundle>(
      "post",
      `/task-runs/${runId}/artifact-bundles`,
      {
        claimToken,
        name: fixture,
        rootPath: fixture,
        ...(fieldPath ? { fieldPath } : {}),
      },
    );
    const root = join(fixturesRoot, fixture);
    const manifest = [];
    for (const path of listFiles(root)) {
      const bytes = readFileSync(join(root, path));
      const relativeStorePath = `${fixture}/${path}`;
      const contentType =
        contentTypes[path.slice(path.lastIndexOf(".") + 1)] ??
        "application/octet-stream";
      const upload = await send<{ uploadUrl: string; objectKey: string }>(
        "post",
        `/task-runs/${runId}/artifact-upload-url`,
        {
          claimToken,
          relativeStorePath,
          contentType,
          sizeBytes: bytes.length,
          bundleId: bundle.id,
        },
      );
      const put = await request.put(upload.uploadUrl, {
        data: bytes,
        headers: { "content-type": contentType },
      });
      expect(put.ok(), `PUT ${relativeStorePath}`).toBe(true);
      await send("post", `/task-runs/${runId}/artifacts`, {
        claimToken,
        objectKey: upload.objectKey,
        relativeStorePath,
        sizeBytes: bytes.length,
        contentType,
        bundleId: bundle.id,
      });
      manifest.push({ path, sizeBytes: bytes.length });
    }
    return await send<Bundle>(
      "post",
      `/task-runs/${runId}/artifact-bundles/${bundle.id}/finalize`,
      { claimToken, manifest },
    );
  };

  const complete = async (
    run: { runId: string; claimToken: string },
    resultJson: Record<string, unknown>,
  ): Promise<void> => {
    await send("post", `/task-runs/${run.runId}/completions`, {
      claimToken: run.claimToken,
      status: "succeeded",
      resultJson,
      errorJson: null,
    });
  };

  const reportRun = await startTask("verify_report", {
    type: "object",
    properties: {
      report: {
        type: "string",
        "x-scarn-artifact": {
          accept: [],
          bundle: { entry: "index.html" },
          share: true,
        },
      },
    },
    required: ["report"],
  });
  const report = await uploadBundle(api, reportRun, "report", "report");
  expect(report.status).toBe("ready");
  await complete(reportRun, { report: "report" });

  const prototypeRun = await startTask("build_prototype", { type: "object" });
  const prototype = await uploadBundle(api, prototypeRun, "prototype");
  expect(prototype.status).toBe("ready");
  await complete(prototypeRun, {});

  const sharePath = (bundleId: string) =>
    `/projects/${projectId}/artifact-bundles/${bundleId}/share`;
  const reportShare = await send<Share>("get", sharePath(report.id));
  expect(reportShare.status).toBe("shared");
  expect(reportShare.shareDeclared).toBe(true);
  const reportUrl = reportShare.url;
  if (!reportUrl) throw new Error("Expected the report share URL");
  expect((await send<Share>("get", sharePath(prototype.id))).status).toBe(
    "private",
  );

  await page.goto(`/projects/${projectId}/artifact-bundles/${prototype.id}`);
  const sharePanel = page.getByRole("region", { name: "Share link" });
  await expect(sharePanel.getByText("Private", { exact: true })).toBeVisible();
  await sharePanel.getByRole("button", { name: "Share", exact: true }).click();
  const prototypeLink = sharePanel.getByText(/\/s\/[^/]+\/$/);
  await expect(prototypeLink).toBeVisible();
  const prototypeUrl = (await prototypeLink.textContent())?.trim() ?? "";
  expect((await send<Share>("get", sharePath(prototype.id))).url).toBe(
    prototypeUrl,
  );

  const contentOrigin = new URL(reportUrl).origin;
  expect(new URL(prototypeUrl).origin).toBe(contentOrigin);
  expect(contentOrigin).not.toBe(new URL(page.url()).origin);

  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(reportUrl);
  await expect(
    anonymousPage.getByRole("heading", { name: "Verification report" }),
  ).toBeVisible();
  for (const id of ["chart", "demo"]) {
    await expect
      .poll(() =>
        anonymousPage
          .locator(`#${id}`)
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
  }
  const video = anonymousPage.locator("#walkthrough");
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);

  await anonymousPage.goto(prototypeUrl);
  await expect(anonymousPage.locator("#prototype-status")).toHaveText(
    "Prototype rendered by JavaScript",
  );

  const authCookies = await context.cookies(new URL(page.url()).origin);
  expect(authCookies.length).toBeGreaterThan(0);
  const contentRequestCookies: Array<string | undefined> = [];
  const contentPage = await context.newPage();
  contentPage.on("request", (request) => {
    if (new URL(request.url()).origin === contentOrigin) {
      void request.allHeaders().then((headers) => {
        contentRequestCookies.push(headers["cookie"]);
      });
    }
  });
  await contentPage.goto(reportUrl);
  await expect
    .poll(() =>
      contentPage
        .locator("#chart")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await contentPage.goto(prototypeUrl);
  await expect(contentPage.locator("#prototype-status")).toBeVisible();
  await expect.poll(() => contentRequestCookies.length).toBeGreaterThan(2);
  for (const cookieHeader of contentRequestCookies) {
    for (const cookie of authCookies) {
      expect(cookieHeader ?? "").not.toContain(`${cookie.name}=`);
    }
  }
  for (const cookie of authCookies) {
    expect(cookie.domain).toBe(new URL(page.url()).hostname);
  }
  await contentPage.close();

  const assetUrl = new URL("assets/app.js", prototypeUrl).toString();
  expect((await anonymousPage.request.get(assetUrl)).status()).toBe(200);
  await sharePanel.getByRole("button", { name: "Revoke link" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke this link?" });
  await dialog.getByRole("button", { name: "Revoke link" }).click();
  await expect(dialog).toBeHidden();
  await expect(sharePanel.getByText("Private", { exact: true })).toBeVisible();
  expect((await anonymousPage.request.get(assetUrl)).status()).toBe(404);
  expect((await anonymousPage.request.get(prototypeUrl)).status()).toBe(404);
  expect((await anonymousPage.request.get(reportUrl)).status()).toBe(200);

  await anonymous.close();
  await context.close();
});
