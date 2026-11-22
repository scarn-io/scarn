import { existsSync, readdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import pg from "pg";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceEnvPath = resolve(root, ".env");

type PackageConfig = {
  name: string;
  cwd: string;
  migrationsDir: string;
  migrationsTable: string;
};

type LocalMigration = {
  name: string;
  hash: string;
};

type MigrationRow = {
  id: number;
  hash: string;
  name: string | null;
};

const packages = [
  {
    name: "@scarn/core",
    cwd: join(root, "packages/core"),
    migrationsDir: join(root, "packages/core/drizzle"),
    migrationsTable: "drizzle.__drizzle_migrations_core",
  },
  {
    name: "@scarn/identity",
    cwd: join(root, "packages/identity"),
    migrationsDir: join(root, "packages/identity/drizzle"),
    migrationsTable: "drizzle.__drizzle_migrations_identity",
  },
  {
    name: "@scarn/growth",
    cwd: join(root, "packages/growth"),
    migrationsDir: join(root, "packages/growth/drizzle"),
    migrationsTable: "drizzle.__drizzle_migrations_growth",
  },
] satisfies PackageConfig[];

function readLocalMigrations(migrationsDir: string): LocalMigration[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      hash: createHash("sha256")
        .update(readFileSync(join(migrationsDir, name, "migration.sql")))
        .digest("hex"),
    }));
}

function getDatabaseUrl() {
  const fromEnv = process.env["DATABASE_URL"];
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const envFile = readFileSync(workspaceEnvPath, "utf-8");
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }

      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, equalsIndex).trim();
      if (key !== "DATABASE_URL") {
        continue;
      }

      const rawValue = trimmed.slice(equalsIndex + 1).trim();
      const quoted =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"));
      return quoted ? rawValue.slice(1, -1) : rawValue;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function logDiagnostics(pkg: PackageConfig) {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    console.error(
      `DATABASE_URL is not set, so extra migration diagnostics are unavailable. Checked process env and ${workspaceEnvPath}.`
    );
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    const localMigrations = readLocalMigrations(pkg.migrationsDir);
    const hasNameColumn = await client.query(
      `select 1 from information_schema.columns
       where table_schema || '.' || table_name = $1 and column_name = 'name'`,
      [pkg.migrationsTable.replaceAll('"', "")]
    );
    const { rows: dbRows } = await client.query<MigrationRow>(
      `select id, hash, ${hasNameColumn.rowCount ? "name" : "null as name"} from ${pkg.migrationsTable} order by id`
    );

    console.error("\nMigration diagnostics:");
    console.error(`- Local migration folders: ${String(localMigrations.length)}`);
    console.error(`- Applied DB rows: ${String(dbRows.length)}`);

    const localByName = new Map(localMigrations.map((m) => [m.name, m]));
    const localHashes = new Set(localMigrations.map((m) => m.hash));
    const mismatches: string[] = [];
    const unmatched: MigrationRow[] = [];

    for (const dbRow of dbRows) {
      const local = dbRow.name ? localByName.get(dbRow.name) : undefined;
      if (local) {
        if (local.hash !== dbRow.hash) {
          mismatches.push(
            `- ${local.name} (row ${String(dbRow.id)}): hash mismatch: db=${dbRow.hash} local=${local.hash}`
          );
        }
      } else if (dbRow.name || !localHashes.has(dbRow.hash)) {
        unmatched.push(dbRow);
      }
    }

    const appliedNames = new Set(dbRows.map((row) => row.name));
    const appliedHashes = new Set(dbRows.map((row) => row.hash));
    const pending = localMigrations.filter(
      (m) => !appliedNames.has(m.name) && !appliedHashes.has(m.hash)
    );

    if (mismatches.length > 0) {
      console.error("- Mismatched applied migrations:");
      for (const mismatch of mismatches) {
        console.error(mismatch);
      }
    }

    if (unmatched.length > 0) {
      console.error("- Applied DB rows with no matching local migration folder:");
      for (const dbRow of unmatched) {
        console.error(`- row ${String(dbRow.id)}: name=${dbRow.name ?? "(none)"} hash=${dbRow.hash}`);
      }
    }

    if (pending.length > 0) {
      console.error("- Local migrations not recorded in DB:");
      for (const migration of pending) {
        console.error(`- ${migration.name}`);
      }
    }

    if (mismatches.length === 0 && unmatched.length === 0) {
      console.error(
        "- Local migrations and DB migration table line up. Drizzle likely failed for a different reason."
      );
    } else {
      console.error("- Drizzle is likely failing because migration history was rewritten after being applied.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Migration diagnostics failed: ${message}`);
  } finally {
    await client.end();
  }
}

for (const pkg of packages) {
  if (!existsSync(pkg.migrationsDir)) {
    console.log(`\n=== ${pkg.name} db:migrate skipped (${pkg.migrationsDir} not present) ===`);
    continue;
  }

  console.log(`\n=== ${pkg.name} db:migrate ===`);

  const proc = Bun.spawn([
    "bun",
    "--env-file=.env",
    "drizzle-kit",
    "migrate",
    "--config=drizzle.config.ts",
  ], {
    cwd: pkg.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`\n${pkg.name} db:migrate failed with exit code ${String(exitCode)}.`);
    await logDiagnostics(pkg);
    process.exit(exitCode);
  }
}
