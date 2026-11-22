/**
 * Push hint to idle workers that a project may have claimable work. Postgres
 * stays the source of truth: a missed or spurious notify only changes how soon
 * a worker polls. Implementations must never reject.
 */
export interface WorkSignal {
  notify(projectId: string): Promise<void>;
}

/**
 * Where workers connect for push wake-ups, and the secret their connect tokens
 * are signed with. Null in `AppContext` when push is not configured.
 */
export type WorkSignalConnectionConfig = {
  url: string;
  tokenSecret: string;
};
