ALTER TABLE "app"."pipeline_runs" ADD COLUMN "started_by_automation_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "started_by_automation_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_started_by_automation_id_automations_id_fk" FOREIGN KEY ("started_by_automation_id") REFERENCES "app"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_started_by_automation_id_automations_id_fk" FOREIGN KEY ("started_by_automation_id") REFERENCES "app"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_runs_started_by_automation_id_idx" ON "app"."pipeline_runs" USING btree ("started_by_automation_id");--> statement-breakpoint
CREATE INDEX "tasks_started_by_automation_id_idx" ON "app"."tasks" USING btree ("started_by_automation_id");