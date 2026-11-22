CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE TABLE "identity"."account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."device_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp with time zone,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "identity"."invitation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."organization" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"active_organization_id" uuid
);
--> statement-breakpoint
CREATE TABLE "identity"."user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"username" text,
	"username_chosen" boolean DEFAULT false NOT NULL,
	"github_login" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."device_code" ADD CONSTRAINT "device_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_account_user_id_idx" ON "identity"."account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_account_provider_account_unique" ON "identity"."account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_device_code_device_code_unique" ON "identity"."device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_device_code_user_code_unique" ON "identity"."device_code" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "identity_device_code_user_id_idx" ON "identity"."device_code" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_invitation_organization_id_idx" ON "identity"."invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "identity_invitation_email_idx" ON "identity"."invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "identity_member_organization_id_idx" ON "identity"."member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "identity_member_user_id_idx" ON "identity"."member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_organization_slug_unique" ON "identity"."organization" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_session_token_unique" ON "identity"."session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "identity_session_user_id_idx" ON "identity"."session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_user_email_unique" ON "identity"."user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_user_username_unique" ON "identity"."user" USING btree ("username") WHERE username IS NOT NULL;--> statement-breakpoint
CREATE INDEX "identity_verification_identifier_idx" ON "identity"."verification" USING btree ("identifier");