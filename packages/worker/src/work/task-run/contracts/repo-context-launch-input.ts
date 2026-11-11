/** A chat run's commit pin, as the launch sees it. */
export type RepoContextLaunchInput = {
  /** The pinned commit; null until a run pins it. */
  baseCommit: string | null;
  /**
   * Reports a freshly resolved commit (and the branch it came from) and
   * returns the stored commit, which the run must use.
   */
  pinBaseCommit(input: {
    baseCommit: string;
    baseBranch: string;
  }): Promise<string>;
};
