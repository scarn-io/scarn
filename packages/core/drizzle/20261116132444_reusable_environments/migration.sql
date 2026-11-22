CREATE TYPE "public"."secret_value_kind" AS ENUM('static');--> statement-breakpoint
ALTER TYPE "public"."secret_kind" ADD VALUE 'project_secret';--> statement-breakpoint
CREATE TABLE "app"."environment_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"content_json" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_versions_schema_version_check" CHECK ("app"."environment_versions"."schema_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"latest_version" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."secrets" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD COLUMN "owner_project_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD COLUMN "value_kind" "secret_value_kind" DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD COLUMN "updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."task_execution_configs" ADD COLUMN "environment_json" jsonb;--> statement-breakpoint
ALTER TABLE "app"."task_runs" ADD COLUMN "environment_version_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."environment_versions" ADD CONSTRAINT "environment_versions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "app"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_versions_environment_version_unique" ON "app"."environment_versions" USING btree ("environment_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_name_unique" ON "app"."environments" USING btree ("project_id","name");--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD CONSTRAINT "secrets_owner_project_id_projects_id_fk" FOREIGN KEY ("owner_project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_runs" ADD CONSTRAINT "task_runs_environment_version_id_environment_versions_id_fk" FOREIGN KEY ("environment_version_id") REFERENCES "app"."environment_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_owner_project_name_unique" ON "app"."secrets" USING btree ("owner_project_id","name");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.task_execution_configs WHERE schema_version NOT IN (1, 2)
  ) THEN
    RAISE EXCEPTION 'environment migration requires stored config version 1 or 2';
  END IF;
END $$;--> statement-breakpoint

-- Match canonicalJson's UTF-16 ordering, including astral object keys.
CREATE FUNCTION app._environment_v3_key(value text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  result text := '';
  point integer;
  position integer;
BEGIN
  FOR position IN 1..length(value) LOOP
    point := ascii(substr(value, position, 1));
    IF point > 65535 THEN
      point := point - 65536;
      result := result || lpad(to_hex(55296 + (point >> 10)), 4, '0')
        || lpad(to_hex(56320 + (point & 1023)), 4, '0');
    ELSE
      result := result || lpad(to_hex(point), 4, '0');
    END IF;
  END LOOP;
  RETURN decode(result, 'hex');
END $$;--> statement-breakpoint

-- JSON.stringify enumerates array-index keys numerically before other keys,
-- even after canonicalJson has inserted the keys in lexicographic order.
CREATE FUNCTION app._environment_v3_canonical(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  result text;
  number_value double precision;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(
        to_jsonb(key)::text || ':' || app._environment_v3_canonical(entry),
        ',' ORDER BY
          CASE WHEN key ~ '^(0|[1-9][0-9]{0,9})$' THEN
            CASE WHEN key::numeric < 4294967295
              THEN key::bigint ELSE 4294967295 END
            ELSE 4294967295 END,
          app._environment_v3_key(key)
      ), '') || '}' INTO result
      FROM jsonb_each(value) AS fields(key, entry);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(
        app._environment_v3_canonical(entry), ',' ORDER BY position
      ), '') || ']' INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS items(entry, position);
    WHEN 'number' THEN
      number_value := value::text::double precision;
      IF number_value = 0 THEN
        result := '0';
      ELSIF abs(number_value) >= 0.000001 AND abs(number_value) < 1e21 THEN
        result := (number_value::text::numeric)::text;
        IF position('.' IN result) > 0 THEN
          result := rtrim(rtrim(result, '0'), '.');
        END IF;
      ELSE
        result := regexp_replace(number_value::text, 'e([+-])0+', 'e\1');
      END IF;
    ELSE
      result := value::text;
  END CASE;
  RETURN result;
END $$;--> statement-breakpoint

UPDATE app.task_execution_configs
SET
  environment_json = CASE
    WHEN runtime_json IS NULL AND env_json IS NULL THEN NULL
    ELSE jsonb_build_object('kind', 'inline')
      || CASE WHEN runtime_json IS NULL THEN '{}'::jsonb ELSE
        jsonb_build_object('runtime',
          CASE runtime_json->>'type'
            WHEN 'none' THEN '{"kind":"host"}'::jsonb
            WHEN 'host' THEN '{"kind":"host"}'::jsonb
            WHEN 'managed' THEN jsonb_build_object(
              'kind', 'managed', 'id', runtime_json->'id')
            WHEN 'devcontainer' THEN jsonb_build_object('kind', 'devcontainer')
              || CASE WHEN runtime_json ? 'configPath'
                THEN jsonb_build_object('config', runtime_json->'configPath')
                ELSE '{}'::jsonb END
          END)
        END
      || CASE WHEN env_json IS NULL THEN '{}'::jsonb ELSE
        jsonb_build_object('vars', (
          SELECT coalesce(jsonb_agg(
            CASE entry->>'source'
              WHEN 'value' THEN jsonb_build_object(
                'name', entry->'name', 'source', 'value',
                'value', entry->'value', 'secret', entry->'secret',
                'applies', coalesce(entry->'applies', '"agent"'::jsonb))
              WHEN 'inherit' THEN jsonb_build_object(
                'name', entry->'name', 'source', 'inherit',
                'from', entry->'from', 'secret', entry->'secret',
                'optional', entry->'optional',
                'applies', coalesce(entry->'applies', '"agent"'::jsonb))
                || CASE WHEN entry ? 'default'
                  THEN jsonb_build_object('default', entry->'default') ELSE '{}'::jsonb END
                || CASE WHEN entry ? 'mcp'
                  THEN jsonb_build_object('mcp', entry->'mcp') ELSE '{}'::jsonb END
            END ORDER BY position
          ), '[]'::jsonb)
          FROM jsonb_array_elements(env_json) WITH ORDINALITY AS vars(entry, position)
        )) END
  END,
  git_json = CASE
    WHEN schema_version = 1 AND (
      git_json->>'mode' = 'none'
      OR (runtime_json->>'type' = 'none' AND git_json IS NULL)
    ) THEN '{"mode":"readOnly","gitCredentials":"none"}'::jsonb
    WHEN git_json IS NULL THEN NULL
    ELSE git_json || jsonb_build_object(
      'gitCredentials', coalesce(git_json->'gitCredentials', '"auto"'::jsonb))
  END,
  health_checks_json = CASE WHEN health_checks_json IS NULL THEN NULL ELSE (
    SELECT coalesce(jsonb_agg(
      entry || jsonb_build_object(
        'kind', coalesce(entry->'kind', '"tool"'::jsonb),
        'severity', coalesce(entry->'severity', '"required"'::jsonb),
        'timeoutSeconds', coalesce(entry->'timeoutSeconds', '15'::jsonb)
      )
      || CASE WHEN entry->>'kind' = 'cli'
        THEN jsonb_build_object('expectExitCode', coalesce(entry->'expectExitCode', '0'::jsonb))
        ELSE '{}'::jsonb END
      ORDER BY position
    ), '[]'::jsonb)
    FROM jsonb_array_elements(health_checks_json) WITH ORDINALITY AS checks(entry, position)
  ) END,
  schema_version = 3;--> statement-breakpoint

-- Hash first in a separate table so converging rows never violate uniqueness.
CREATE TEMP TABLE _environment_v3_hashes AS
SELECT id, project_id, encode(sha256(convert_to(
  app._environment_v3_canonical(jsonb_build_object(
    'schemaVersion', 3,
    'environment', environment_json,
    'git', CASE WHEN git_json->>'gitCredentials' = 'auto'
      THEN git_json - 'gitCredentials' ELSE git_json END,
    'mcp', mcp_json,
    'healthChecks', health_checks_json
  )), 'UTF8')), 'hex') AS content_hash
FROM app.task_execution_configs;--> statement-breakpoint

CREATE TEMP TABLE _environment_v3_duplicates AS
SELECT id, first_value(id) OVER (
  PARTITION BY project_id, content_hash ORDER BY id
) AS canonical_id
FROM _environment_v3_hashes;--> statement-breakpoint

UPDATE app.step_definitions AS target
SET task_execution_config_id = duplicate.canonical_id
FROM _environment_v3_duplicates AS duplicate
WHERE target.task_execution_config_id = duplicate.id
  AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint

UPDATE app.tasks AS target
SET task_execution_config_id = duplicate.canonical_id
FROM _environment_v3_duplicates AS duplicate
WHERE target.task_execution_config_id = duplicate.id
  AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint

DELETE FROM app.task_execution_configs AS target
USING _environment_v3_duplicates AS duplicate
WHERE target.id = duplicate.id
  AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint

-- Free old hashes before assigning new ones (an old hash may equal another's new hash).
UPDATE app.task_execution_configs
SET content_hash = 'environment-v3-migrating:' || id::text;--> statement-breakpoint

UPDATE app.task_execution_configs AS target
SET content_hash = hashes.content_hash
FROM _environment_v3_hashes AS hashes
WHERE target.id = hashes.id;--> statement-breakpoint

DROP FUNCTION app._environment_v3_canonical(jsonb);--> statement-breakpoint
DROP FUNCTION app._environment_v3_key(text);--> statement-breakpoint
DROP TABLE _environment_v3_duplicates;--> statement-breakpoint
DROP TABLE _environment_v3_hashes;--> statement-breakpoint

ALTER TABLE "app"."task_execution_configs" DROP COLUMN "runtime_json";--> statement-breakpoint
ALTER TABLE "app"."task_execution_configs" DROP COLUMN "env_json";--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD CONSTRAINT "secrets_exactly_one_owner_check" CHECK (num_nonnulls("app"."secrets"."owner_user_id", "app"."secrets"."owner_project_id") = 1);
