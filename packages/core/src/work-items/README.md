# Work Items

This domain contains work item records associated with projects.

Responsibilities in this domain include work item titles and descriptions, provider metadata, external issue identifiers, URLs, labels, status, severity, and projection data derived from work item content.

Current entities in this domain include the `work-item` entity and its projection fingerprint support, `work-item-comment` and `work-item-block`.

## Comments

A work item's comments are its conversation. A comment is authored by a project member (`authorKind: "user"`) or by Scarn (`authorKind: "agent"`, no author user):

- `WorkItemCommentEntity.create`: a member's comment, through `createWorkItemComment` (`comments:create`).
- `WorkItemCommentEntity.createFromApprovedDraft`: an agent-drafted comment a member approved; it keeps the agent session and source notification.
- `WorkItemCommentEntity.createAgentQuestion`: a question the pipeline engine asks, with no session or source notification. The engine writes it straight through the repo, with no permission check. What makes it a question is a `node_visit_questions` row pointing at it, which belongs to `pipeline-executions/pipeline-run`. This domain doesn't know about questions.

**Replies** are one level deep. `parentCommentId` points at the comment being replied to, which must be a top-level comment on the same work item; otherwise creation fails with `WORK_ITEM_COMMENT_PARENT_INVALID` (also when the parent doesn't exist). Deleting a comment deletes its replies. `loadByWorkItemId` returns the whole thread, replies included, oldest first.

Do not place project configuration, pipeline definition data, pipeline execution state, or agent/runtime session records in this domain.
