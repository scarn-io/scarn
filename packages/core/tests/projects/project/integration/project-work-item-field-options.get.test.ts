import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { getDb } from "@/lib/db";
import { projectMemberships } from "@/lib/db/schema";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import {
  MAX_FIELD_OPTION_KEYS,
  MAX_FIELD_OPTION_VALUES,
} from "@/work-items/work-item/contracts/work-item-contracts";
import { createTestUserAndSession } from "./auth-test-utils";
import {
  createListingProject,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * `GET /projects/:projectId/work-item-field-options` — the filter dropdowns'
 * data source. Scalars only, distinct, sorted, project-scoped, and capped both
 * per key and in key count so a project with pathological `fields` cannot return
 * an unbounded payload.
 */
describe("project work item field options get endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  const listFieldOptions = async (project: ListingProject) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.projectId })
        ["work-item-field-options"].get({
          headers: { ...project.authHeaders },
        }),
    );

  concurrentTest(
    "returns distinct sorted scalar values and skips non-scalars",
    async () => {
      const project = await createListingProject(apiClient, "field-options");
      await seedWorkItems(apiClient, project, [
        {
          fields: {
            env: "prod",
            tier: "gold",
            count: 5,
            flag: true,
            obj: { nested: 1 },
            arr: [1, 2],
            nil: null,
          },
        },
        { fields: { env: "dev", tier: "gold" } },
        // Repeats "prod" — the values must be deduplicated.
        { fields: { env: "prod" } },
        { fields: null },
        { fields: {} },
      ]);

      const options = await listFieldOptions(project);

      expect(options).toEqual([
        { key: "count", values: ["5"], truncated: false },
        { key: "env", values: ["dev", "prod"], truncated: false },
        { key: "flag", values: ["true"], truncated: false },
        { key: "tier", values: ["gold"], truncated: false },
      ]);
    },
  );

  concurrentTest(
    "returns an empty list for a project with no work items",
    async () => {
      const project = await createListingProject(
        apiClient,
        "field-options-empty",
      );

      expect(await listFieldOptions(project)).toEqual([]);
    },
  );

  concurrentTest("is scoped to the requested project", async () => {
    const project = await createListingProject(
      apiClient,
      "field-options-scope",
    );
    const other = await createListingProject(
      apiClient,
      "field-options-scope-other",
    );
    await seedWorkItems(apiClient, project, [{ fields: { mine: "yes" } }]);
    await seedWorkItems(apiClient, other, [{ fields: { theirs: "yes" } }]);

    expect(await listFieldOptions(project)).toEqual([
      { key: "mine", values: ["yes"], truncated: false },
    ]);
    expect(await listFieldOptions(other)).toEqual([
      { key: "theirs", values: ["yes"], truncated: false },
    ]);
  });

  concurrentTest(
    "caps the values per key and flags the key as truncated",
    async () => {
      const project = await createListingProject(
        apiClient,
        "field-options-value-cap",
      );
      const distinctValues = MAX_FIELD_OPTION_VALUES + 1;
      await seedWorkItems(
        apiClient,
        project,
        Array.from({ length: distinctValues }, (_unused, index) => ({
          fields: {
            // Zero-padded so lexicographic order matches numeric order.
            big: `value-${String(index).padStart(4, "0")}`,
            small: "constant",
          } satisfies AnyJsonObject,
        })),
      );

      const options = await listFieldOptions(project);
      const big = options.find((option) => option.key === "big");
      const small = options.find((option) => option.key === "small");

      expect(big?.values).toHaveLength(MAX_FIELD_OPTION_VALUES);
      expect(big?.truncated).toBeTrue();
      expect(big?.values[0]).toBe("value-0000");
      // A key comfortably inside the cap is not flagged.
      expect(small).toEqual({
        key: "small",
        values: ["constant"],
        truncated: false,
      });
    },
  );

  concurrentTest("caps the number of keys returned", async () => {
    const project = await createListingProject(
      apiClient,
      "field-options-key-cap",
    );
    const fields: AnyJsonObject = {};
    for (let index = 0; index < MAX_FIELD_OPTION_KEYS + 25; index += 1) {
      fields[`key-${String(index).padStart(4, "0")}`] = "present";
    }
    await seedWorkItems(apiClient, project, [{ fields }]);

    const options = await listFieldOptions(project);

    expect(options).toHaveLength(MAX_FIELD_OPTION_KEYS);
    // The retained keys are the alphabetically first ones.
    expect(options[0]?.key).toBe("key-0000");
    expect(options[MAX_FIELD_OPTION_KEYS - 1]?.key).toBe(
      `key-${String(MAX_FIELD_OPTION_KEYS - 1).padStart(4, "0")}`,
    );
  });

  concurrentTest(
    "returns 404 when the request is unauthenticated and the project does not exist",
    async () => {
      // With no session at all, the request never learns the project's
      // visibility, so a nonexistent project 404s exactly like it would for
      // an authenticated caller (see the private-project case below for the
      // 401 an unauthenticated caller gets against a *real* private project).
      const { data, error } = await apiClient.api
        .projects({ projectId: uuidv7() })
        ["work-item-field-options"].get();

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
    },
  );

  concurrentTest(
    "returns 401 when the request is unauthenticated and the project is private",
    async () => {
      const project = await createListingProject(apiClient, "field-options-anon");

      const { data, error } = await apiClient.api
        .projects({ projectId: project.projectId })
        ["work-item-field-options"].get();

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest("returns 404 when the project does not exist", async () => {
    const user = await createTestUserAndSession({
      email: `field-options-missing-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api
      .projects({ projectId: uuidv7() })
      ["work-item-field-options"].get({
        headers: { ...user.authHeaders },
      });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  concurrentTest(
    "returns 403 when the member cannot read work items",
    async () => {
      const project = await createListingProject(
        apiClient,
        "field-options-forbidden",
      );
      const member = await createTestUserAndSession({
        email: `field-options-member-${crypto.randomUUID()}@example.com`,
      });

      await getDb()
        .insert(projectMemberships)
        .values({
          projectId: project.projectId,
          userId: member.userId,
          role: "retired-role",
        });

      const { data, error } = await apiClient.api
        .projects({ projectId: project.projectId })
        ["work-item-field-options"].get({
          headers: { ...member.authHeaders },
        });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({
        status: 403,
        code: "PROJECT_FORBIDDEN",
      });
    },
  );
});
