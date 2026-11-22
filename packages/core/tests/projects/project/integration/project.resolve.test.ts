import { eq } from "drizzle-orm";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { createApp } from "@scarn/api/app";
import { describe, expect } from "bun:test";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";

describe("project resolve endpoint (pretty-url resolution)", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-24T12:00:00.000Z")),
    }),
  );

  concurrentTest(
    "resolves a project by owner username + slug",
    async () => {
      const apiClient = createScarnTreaty(app);
      const username = `resolver${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const owner = await createTestUserAndSession({
        email: `owner-${crypto.randomUUID()}@example.com`,
        username,
      });

      const created = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Resolver Demo",
            description: "For resolution",
            gitUrl: "https://github.com/example/resolver-demo.git",
          },
          { headers: owner.authHeaders },
        ),
      );

      expect(created.slug).toBe("resolver-demo");

      const { data, error } = await apiClient.api.projects.resolve.get({
        query: { username, slug: created.slug },
        headers: owner.authHeaders,
      });

      expect(error).toBeNull();
      expect(data?.id).toBe(created.id);
      expect(data?.slug).toBe("resolver-demo");
      // The owner username is resolved at read time (never persisted on the
      // project) and matches the URL owner segment.
      expect(data?.ownerUsername).toBe(username);
    },
  );

  concurrentTest("404s for an unknown username", async () => {
    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `owner-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api.projects.resolve.get({
      query: { username: "nobody-here-xyz", slug: "whatever" },
      headers: owner.authHeaders,
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  concurrentTest("404s for an unknown slug", async () => {
    const apiClient = createScarnTreaty(app);
    const username = `resolver${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const owner = await createTestUserAndSession({
      email: `owner-${crypto.randomUUID()}@example.com`,
      username,
    });

    await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Has A Project",
          description: null,
          gitUrl: "https://github.com/example/has-a-project.git",
        },
        { headers: owner.authHeaders },
      ),
    );

    const { data, error } = await apiClient.api.projects.resolve.get({
      query: { username, slug: "no-such-slug" },
      headers: owner.authHeaders,
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  concurrentTest(
    "returns 401 for an anonymous request against a real private project",
    async () => {
      const apiClient = createScarnTreaty(app);
      const username = `resolver${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const owner = await createTestUserAndSession({
        email: `owner-${crypto.randomUUID()}@example.com`,
        username,
      });
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Anon Resolve Private",
            description: "Private project",
            gitUrl: "https://github.com/example/anon-resolve-private.git",
          },
          { headers: owner.authHeaders },
        ),
      );

      const { data, error } = await apiClient.api.projects.resolve.get({
        query: { username, slug: project.slug },
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest(
    "returns 404 (not 401) for an anonymous request against an unknown username",
    async () => {
      // With no session at all, the request never learns whether a matching
      // project's visibility, so an unresolvable username 404s exactly like
      // it would for an authenticated caller — see the private-project case
      // above for the 401 an unauthenticated caller gets against a *real*
      // private project.
      const apiClient = createScarnTreaty(app);

      const { data, error } = await apiClient.api.projects.resolve.get({
        query: { username: "nobody-here-anon-xyz", slug: "whatever" },
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
    },
  );

  concurrentTest(
    "an anonymous caller can resolve a public project by owner username + slug",
    async () => {
      const apiClient = createScarnTreaty(app);
      const username = `resolver${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const owner = await createTestUserAndSession({
        email: `owner-${crypto.randomUUID()}@example.com`,
        username,
      });
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Anon Resolve Public",
            description: "Public project",
            gitUrl: "https://github.com/example/anon-resolve-public.git",
          },
          { headers: owner.authHeaders },
        ),
      );
      await getDb()
        .update(projects)
        .set({ visibility: "public" })
        .where(eq(projects.id, project.id));

      const { data, error } = await apiClient.api.projects.resolve.get({
        query: { username, slug: project.slug },
      });

      expect(error).toBeNull();
      expect(data?.id).toBe(project.id);
      expect(data?.visibility).toBe("public");
    },
  );

  concurrentTest(
    "de-dupes slugs within an org (second same-named project gets -2)",
    async () => {
      const apiClient = createScarnTreaty(app);
      const owner = await createTestUserAndSession({
        email: `owner-${crypto.randomUUID()}@example.com`,
      });

      const first = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Duplicate Name",
            description: null,
            gitUrl: "https://github.com/example/dup-one.git",
          },
          { headers: owner.authHeaders },
        ),
      );
      const second = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Duplicate Name",
            description: null,
            gitUrl: "https://github.com/example/dup-two.git",
          },
          { headers: owner.authHeaders },
        ),
      );

      expect(first.slug).toBe("duplicate-name");
      expect(second.slug).toBe("duplicate-name-2");
    },
  );
});
