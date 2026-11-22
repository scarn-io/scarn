import type { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";

export type BrowserApiClient = ReturnType<typeof getBrowserScarnApiClient>;
export type PipelineExecutionTableApiClient = Pick<BrowserApiClient, "api">;

export type LoadState = "idle" | "loading" | "loaded" | "error";
