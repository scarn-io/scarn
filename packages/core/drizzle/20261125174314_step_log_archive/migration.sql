CREATE TYPE "log_archive" AS ENUM('always', 'on-failure');--> statement-breakpoint
ALTER TABLE "app"."step_definitions" ADD COLUMN "log_archive" "log_archive" DEFAULT 'always'::"log_archive" NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "log_archive" "log_archive" DEFAULT 'always'::"log_archive" NOT NULL;