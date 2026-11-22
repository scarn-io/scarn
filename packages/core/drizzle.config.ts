import { defineConfig } from "drizzle-kit";

export default defineConfig({
  migrations: {
    schema: "drizzle",
    table: "__drizzle_migrations_core",
  },
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  verbose: true,
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
