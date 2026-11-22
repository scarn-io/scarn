import { z } from "zod";
import { isAuthId } from "../domain/auth-id";

const authIdSchema = z
  .string()
  .trim()
  .refine(isAuthId, "Auth id must be a UUID v7");

// Single source of truth for reserved usernames. These collide with routes,
// system names, or brand terms and must be rejected everywhere a username is
// chosen (signup, rename, and the generator). `usernameSchema` refines against
// this set so no caller can bypass it.
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set<string>([
  "api",
  "login",
  "logout",
  "signup",
  "invite",
  "settings",
  "projects",
  "organizations",
  "new",
  "_next",
  "static",
  "assets",
  "admin",
  "dashboard",
  "support",
  "help",
  "about",
  "www",
  "mail",
]);

// Lowercase alphanumerics and single interior hyphens only: no leading/trailing
// hyphen, no double hyphen, 3-32 chars. Refined against RESERVED_USERNAMES so
// reserved names are rejected from one source of truth.
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Username must be lowercase letters, numbers, or single interior hyphens",
  )
  .refine(
    (value) => !RESERVED_USERNAMES.has(value),
    "Username is reserved",
  );

export const authUserSchema = z.object({
  id: authIdSchema,
  email: z.email(),
  // Null until the user picks a handle during onboarding.
  username: usernameSchema.nullable(),
  name: z.string().trim().min(1),
  emailVerified: z.boolean(),
  usernameChosen: z.boolean(),
  image: z.string().trim().min(1).nullable(),
  createdAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const authSessionSchema = z.object({
  id: authIdSchema,
  userId: authIdSchema,
  token: z.string().trim().min(1),
  expiresAt: z.iso.datetime(),
  ipAddress: z.string().trim().min(1).nullable(),
  userAgent: z.string().trim().min(1).nullable(),
  createdAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const authAccountSchema = z.object({
  id: authIdSchema,
  accountId: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  userId: authIdSchema,
  accessToken: z.string().trim().min(1).nullable(),
  refreshToken: z.string().trim().min(1).nullable(),
  idToken: z.string().trim().min(1).nullable(),
  accessTokenExpiresAt: z.iso.datetime().nullable(),
  refreshTokenExpiresAt: z.iso.datetime().nullable(),
  scope: z.string().trim().min(1).nullable(),
  createdAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const authVerificationSchema = z.object({
  id: authIdSchema,
  identifier: z.string().trim().min(1),
  value: z.string().trim().min(1),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const authSessionWithUserSchema = z.object({
  session: authSessionSchema,
  user: authUserSchema,
});

export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type AuthAccount = z.infer<typeof authAccountSchema>;
export type AuthVerification = z.infer<typeof authVerificationSchema>;
export type AuthSessionWithUser = z.infer<typeof authSessionWithUserSchema>;
