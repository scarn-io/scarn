"use client";

import { Suspense, use } from "react";
import { useProjectRoute } from "@/components/project-route-context";
import { RunTaskPage } from "@/components/runs/run-pages";

export default function ProjectRunTaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = use(params);
  const { projectId } = useProjectRoute();
  return (
    <Suspense>
      <RunTaskPage projectId={projectId} taskId={taskId} />
    </Suspense>
  );
}
