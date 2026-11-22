# Pipeline Definitions

This domain contains the definitions that describe how project work flows through pipelines.

Responsibilities in this domain include pipelines, their published versions, and step definitions.

- `pipeline-graph` — a pipeline handle (`pipeline_graphs`) and its immutable
  published versions (`pipeline_graph_versions` + `pipeline_graph_version_steps`).
  A version stores the validated JSON pipeline document
  (`@scarn/sdk/contracts/pipeline-document`), its content hash, and the step definition
  version pinned for every step key the document uses. Publishing validates the
  document against the step catalog, pins the latest active step versions, and
  is a no-op when the hash matches the latest version. Activating points the
  pipeline's `current_version_id` at an existing version.
- `step-definition` — versioned step definitions with required input/result
  JSON schemas and declared error codes.

Pipeline templates are not stored here: they ship with the CLI and are used
from `scarn pipelines studio`.

Do not place runtime execution state, queued or claimed work, or agent/runtime session records in this domain.
