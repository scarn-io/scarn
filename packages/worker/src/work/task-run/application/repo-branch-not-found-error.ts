export class RepoBranchNotFoundError extends Error {
  readonly code = "SCARN_REPO_BRANCH_NOT_FOUND";

  constructor(readonly branch: string) {
    super(`Repository branch "${branch}" was not found on origin.`);
    this.name = "Scarn.RepoBranchNotFound";
  }
}
