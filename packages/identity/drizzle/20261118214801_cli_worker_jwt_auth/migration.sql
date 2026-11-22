CREATE TABLE "identity"."jwks" (
	"id" uuid PRIMARY KEY,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
ALTER TABLE "identity"."account" ADD COLUMN "password" text;