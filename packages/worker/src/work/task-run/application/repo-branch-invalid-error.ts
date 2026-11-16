/**
 * A step's base branch can't be used: its `baseBranch` template rendered a
 * token empty or to something that isn't a valid branch name, it names a
 * secret var, or (`WorkBranch.base()`) the base came from a rule the step
 * may not commit onto.
 */
export class RepoBranchInvalidError extends Error {
  readonly code = "SCARN_REPO_BRANCH_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "Scarn.RepoBranchInvalid";
  }
}
