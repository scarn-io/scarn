-- Fixed-id users the app relies on at runtime. Ids must match the constants in
-- `packages/core`:
--   * `SYSTEM_ACTOR_ID` (`access/authorization/system-actor.ts`): unattended,
--     system-initiated actions (e.g. scheduled reconciliation runs).
--   * `ANONYMOUS_ACTOR_ID` (`access/authorization/anonymous-actor.ts`): HTTP
--     requests with no session (e.g. a logged-out visitor on a public project).
--   * `DEMO_ACCOUNT_USER_ID` / `DEMO_ACCOUNT_USERNAME` / `DEMO_ACCOUNT_NAME`
--     (`demo-project/demo-account.ts`): owner of the public demo project at
--     `/scarn/demo`. Its `username` must be set here, not by the seed script:
--     `DrizzleAuthUserRepo.save` never overwrites an existing row's username.
--
-- Idempotent via ON CONFLICT.

INSERT INTO "identity"."user" (id, name, email, email_verified)
VALUES (
  '01977e00-0000-7000-8000-000000000001',
  'Scarn System',
  'system@scarn.internal',
  false
)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "identity"."user" (id, name, email, email_verified)
VALUES (
  '01977e00-0000-7000-8000-000000000002',
  'Scarn Anonymous',
  'anonymous@scarn.internal',
  false
)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "identity"."user" (id, name, email, username, username_chosen, email_verified)
VALUES (
  '01977e00-0000-7000-8000-000000000003',
  'Scarn Demo',
  'demo@scarn.internal',
  'scarn',
  true,
  false
)
ON CONFLICT (id) DO NOTHING;
