import { z } from "zod";
import { CoreValidationError } from "@scarn/core/lib/errors";

export type ProjectGitUrl = string & { readonly __brand: "project-git-url" };

const scpLikeGitUrlPattern = /^[A-Za-z0-9._-]+@[^:\s]+:[^\s]+$/u;
const absolutePathPattern = /^(\/|[A-Za-z]:[\\/])/u;
const allowedProtocols = new Set([
  "file:",
  "git:",
  "git+ssh:",
  "http:",
  "https:",
  "ssh:",
]);

export const isProjectGitUrl = (value: string): boolean => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return false;
  }

  if (
    scpLikeGitUrlPattern.test(normalizedValue) ||
    absolutePathPattern.test(normalizedValue)
  ) {
    return true;
  }

  try {
    const parsed = new URL(normalizedValue);
    return allowedProtocols.has(parsed.protocol);
  } catch {
    return false;
  }
};

export const parseProjectGitUrl = (value: string): ProjectGitUrl => {
  const normalizedValue = value.trim();

  if (!isProjectGitUrl(normalizedValue)) {
    throw new CoreValidationError(
      `Project gitUrl must be a valid git repository URL or absolute path: ${value}`,
      "INVALID_PROJECT_GIT_URL",
    );
  }

  return normalizedValue as ProjectGitUrl;
};

export const projectGitUrlSchema = z
  .string()
  .trim()
  .refine((value) => isProjectGitUrl(value), {
    message: "gitUrl must be a valid git repository URL or absolute path",
  });
