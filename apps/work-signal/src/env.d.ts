declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "ProjectWorkSignal" | "TaskRunLogFeed";
  }
  interface Env {
    PROJECT_WORK_SIGNAL: DurableObjectNamespace<
      import("./project-work-signal").ProjectWorkSignal
    >;
    TASK_RUN_LOG_FEED: DurableObjectNamespace<
      import("./task-run-log-feed").TaskRunLogFeed
    >;
    WORK_SIGNAL_NOTIFY_SECRET: string;
    WORK_SIGNAL_TOKEN_SECRET: string;
    LOG_FEED_INTERNAL_SECRET: string;
    LOG_FEED_TOKEN_SECRET: string;
    AUTH_FAIL_LIMITER: RateLimit;
    WS_WORKER_LIMITER: RateLimit;
    WS_ORG_LIMITER: RateLimit;
    FEED_WRITER_LIMITER: RateLimit;
    FEED_READER_LIMITER: RateLimit;
    EDGE_EVENTS: AnalyticsEngineDataset;
  }
}
