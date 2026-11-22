import type { Logger } from "@scarn/observability/logging";
import type {
  WorkSignal,
  WorkSignalConnectionConfig,
} from "../application/work-signal";

const DEFAULT_NOTIFY_TIMEOUT_MS = 1000;

/**
 * Notifies the work-signal Worker (`apps/work-signal`) over HTTP. Bounded by
 * a timeout; every failure is logged and swallowed so callers never fail.
 */
export class HttpWorkSignal implements WorkSignal {
  private readonly baseUrl: string;
  private readonly notifySecret: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: {
    url: string;
    notifySecret: string;
    logger: Logger;
    timeoutMs?: number;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.notifySecret = options.notifySecret;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  public async notify(projectId: string): Promise<void> {
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/notify`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.notifySecret}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!response.ok) {
        this.logger.warn(
          { projectId, status: response.status },
          "work-signal notify failed",
        );
      }
    } catch (error) {
      this.logger.warn({ projectId, err: error }, "work-signal notify failed");
    }
  }
}

export class NoopWorkSignal implements WorkSignal {
  public notify(): Promise<void> {
    return Promise.resolve();
  }
}

/** `HttpWorkSignal` when `WORK_SIGNAL_URL` and the notify secret are set; otherwise a no-op. */
export const createWorkSignalFromEnv = (logger: Logger): WorkSignal => {
  const url = process.env["WORK_SIGNAL_URL"];
  const notifySecret = process.env["WORK_SIGNAL_NOTIFY_SECRET"];
  return url && notifySecret
    ? new HttpWorkSignal({ url, notifySecret, logger })
    : new NoopWorkSignal();
};

/** Null unless both `WORK_SIGNAL_URL` and `WORK_SIGNAL_TOKEN_SECRET` are set. */
export const resolveWorkSignalConnectionFromEnv =
  (): WorkSignalConnectionConfig | null => {
    const url = process.env["WORK_SIGNAL_URL"];
    const tokenSecret = process.env["WORK_SIGNAL_TOKEN_SECRET"];
    return url && tokenSecret
      ? { url: url.replace(/\/+$/, ""), tokenSecret }
      : null;
  };
