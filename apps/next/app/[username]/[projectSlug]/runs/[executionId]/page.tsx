"use client";

import { Suspense, use } from "react";
import { ExecutionDetailView } from "@/components/executions/execution-detail-view";
import { useProjectRoute } from "@/components/project-route-context";

export default function ProjectRunPipelinePage({
  params,
}: {
  params: Promise<{ executionId: string }>;
}) {
  const { executionId } = use(params);
  const { projectId } = useProjectRoute();

  return (
    <Suspense>
      <ExecutionDetailView projectId={projectId} executionId={executionId} />
    </Suspense>
  );
}
