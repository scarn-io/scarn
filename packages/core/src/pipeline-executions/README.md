# Pipeline Executions

This domain contains runtime state for executing pipelines: runs, the node visits a run makes, the lane groups and lanes of fan-outs, and the link from a visit to the Tasks it queued.

The only entity is `pipeline-run`; see `pipeline-run/README.md` for how a run advances.

The claimable unit of execution (Task) lives in `tasks/`. A Task is pipeline-unaware: a step visit references its Task (`node_visits.task_id`), never the other way round. The routing rules a run follows come from the published pipeline document (`pipeline-definitions/pipeline-graph`) and the pure engine in `pipeline-run/domain/engine/`.

Do not place static pipeline definition configuration, project membership data, Task claim/lease/log/artifact state, or agent session records in this domain.
