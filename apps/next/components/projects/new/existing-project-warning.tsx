"use client";

import { Alert, Link } from "@mui/material";
import { projectPath } from "@/app/(protected)/projects/_lib/project-routing";
import type { RepoCheck } from "./repo-host";

/** Warns that one of the user's projects already uses this repo. */
export function ExistingProjectWarning({ check }: { check: RepoCheck }) {
  if (!check.alreadyExists) return null;
  const existing = check.existingProject;
  return (
    <Alert severity="warning">
      {existing?.ownerUsername ? (
        <>
          <Link href={projectPath(existing.ownerUsername, existing.slug)}>
            {existing.name}
          </Link>{" "}
          already uses this repository.
        </>
      ) : (
        "One of your projects already uses this repository."
      )}{" "}
      You can still create another project for it.
    </Alert>
  );
}
