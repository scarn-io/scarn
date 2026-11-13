import type { ControlSupervisor } from "../../../../../src/work/worker-host/infra/control-app";
import type {
  ProjectSettingsInput,
  WorkerSupervisorState,
} from "../../../../../src/work/worker-host/application/worker-supervisor";

type Call = { method: string; args: unknown[] };

/** Records each call the control API makes; tests set what it returns. */
export class FakeControlSupervisor implements ControlSupervisor {
  readonly calls: Call[] = [];
  state: WorkerSupervisorState = "running";
  readonly instance = "scarn-test";
  addOrUpdateError: Error | null = null;
  stopped = Promise.withResolvers<undefined>();

  addOrUpdateProject(input: ProjectSettingsInput) {
    this.calls.push({ method: "addOrUpdateProject", args: [input] });
    if (this.addOrUpdateError) return Promise.reject(this.addOrUpdateError);
    return Promise.resolve({ outcome: "added" as const, project: null });
  }

  removeProject(projectId: string) {
    this.calls.push({ method: "removeProject", args: [projectId] });
    return { removed: true, drainingRuns: [] };
  }

  setMachineLimit(limit: number) {
    this.calls.push({ method: "setMachineLimit", args: [limit] });
    return { maxConcurrency: limit };
  }

  cancelRun(taskRunId: string) {
    this.calls.push({ method: "cancelRun", args: [taskRunId] });
    return { found: taskRunId === "run-1" };
  }

  stop(options: { force?: boolean } = {}) {
    this.calls.push({ method: "stop", args: [options] });
    this.state = options.force ? "stopping" : "draining";
    return this.stopped.promise;
  }

  status(options: { recentRuns?: number } = {}) {
    this.calls.push({ method: "status", args: [options] });
    return {
      instance: this.instance,
      baseUrl: "https://scarn.test",
      state: this.state,
      maxConcurrency: 4,
      slots: { machineLimit: 4, machineInUse: 0, projects: [] },
      projects: [],
      activeRuns: [],
      recentRuns: [],
    };
  }
}
