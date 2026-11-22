import { expect, test } from "@playwright/test";
import { LoginPage } from "./models/pages/login-page";
import { projectRoutePath } from "./models/pages/project-route";
import { goToPage } from "./support/go-to-page";

test("a user retries a failed Task and a worker completes the new attempt", async ({
  page,
}) => {
  test.slow();
  const login = await goToPage(page, LoginPage, LoginPage.path());
  const dashboard = await login.signInAsDevUser(
    `task-retry-${crypto.randomUUID()}@scarn.local`,
  );
  const project = await dashboard.createProject({
    name: "Task retry e2e",
    description: "Manual retry worker lifecycle",
    gitUrl: "https://github.com/example/task-retry-e2e",
  });
  const projectPath = projectRoutePath(project.location);
  await page.goto(`${projectPath}/work-items/new`);
  await page.getByLabel("Add a title").fill("Retry a failed attempt");
  await page
    .getByLabel("Add a description")
    .fill("Keep both attempts visible.");
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

  const post = async <T>(
    path: string,
    data: Record<string, unknown>,
  ): Promise<T> => {
    const response = await page.request.post(`/api${path}`, { data });
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return (await response.json()) as T;
  };
  const step = await post<{ id: string }>("/step-definitions", {
    projectId,
    key: `retry_e2e_${crypto.randomUUID()}`,
    name: "Retry smoke step",
    description: "Retry smoke step",
    version: 1,
    kind: "user_defined",
    prompt: "Return a result.",
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    status: "active",
    repo: { mode: "readOnly" },
  });
  const created = await post<{ task: { id: string }; run: { id: string } }>(
    "/tasks",
    {
      projectId,
      workItemId,
      stepDefinitionId: step.id,
      stepDefinitionVersion: 1,
      inputJson: null,
    },
  );
  type Claim = { task: { id: string }; claimToken: string };
  const claim = async (runId: string) => {
    const claims = await post<Claim[]>("/task-runs/claims", {
      projectId,
      workItemId,
      workerId: `retry-e2e-${crypto.randomUUID()}`,
      batchSize: 1,
      leaseDurationSeconds: 120,
    });
    const claimed = claims.find((candidate) => candidate.task.id === runId);
    if (!claimed) throw new Error(`Expected worker claim for ${runId}`);
    return claimed.claimToken;
  };
  await post(`/task-runs/${created.run.id}/completions`, {
    claimToken: await claim(created.run.id),
    status: "failed",
    resultJson: null,
    errorJson: { name: "Scarn.StepFailed", message: "First attempt failed" },
  });
  const taskPath = `${projectPath}/runs/tasks/${created.task.id}`;
  await page.goto(taskPath);
  const retry = page.getByRole("button", { name: "Retry task", exact: true });
  await expect(retry).toBeVisible();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/tasks/${created.task.id}/retry`) &&
      response.request().method() === "POST",
  );
  await retry.click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const retried = (await response.json()) as {
    taskId: string;
    taskRunId: string;
  };
  expect(retried.taskId).toBe(created.task.id);
  expect(retried.taskRunId).not.toBe(created.run.id);
  await expect(retry).toBeHidden();
  await expect(page.locator('[data-run-section="2"]')).toBeVisible();
  await post(`/task-runs/${retried.taskRunId}/completions`, {
    claimToken: await claim(retried.taskRunId),
    status: "succeeded",
    resultJson: { done: true },
    errorJson: null,
  });
  await page.reload();
  await expect(page.getByText("Done", { exact: true })).toBeVisible();
  await expect(page.locator('[data-run-section="1"]')).toContainText("failed");
  await expect(page.locator('[data-run-section="2"]')).toContainText("done");
  await expect(retry).toBeHidden();
  expect(new URL(page.url()).pathname).toBe(taskPath);
  const runsResponse = await page.request.get(
    `/api/tasks/${created.task.id}/runs`,
  );
  expect(runsResponse.ok()).toBe(true);
  const runs = (await runsResponse.json()) as Array<{
    id: string;
    status: string;
  }>;
  expect(runs.map((run) => [run.id, run.status])).toEqual([
    [created.run.id, "failed"],
    [retried.taskRunId, "succeeded"],
  ]);
});
