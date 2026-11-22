ALTER TABLE "app"."project_memberships" ADD COLUMN "role" text;--> statement-breakpoint
UPDATE "app"."project_memberships" SET "role" = CASE
  WHEN "permissions" @> '["secrets:write"]'::jsonb THEN 'admin'
  WHEN "permissions" @> '["executions:write"]'::jsonb THEN 'write'
  ELSE 'read'
END;--> statement-breakpoint
ALTER TABLE "app"."project_memberships" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."project_memberships" DROP COLUMN "permissions";--> statement-breakpoint
UPDATE "app"."project_invites" SET "role" = CASE "role"
  WHEN 'contributor' THEN 'write'
  WHEN 'reviewer' THEN 'read'
  ELSE "role"
END;--> statement-breakpoint
ALTER TABLE "app"."project_invites" DROP COLUMN "permissions";
