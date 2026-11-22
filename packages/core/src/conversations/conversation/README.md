# Conversation

A conversation between an agent and people. Every conversation belongs to a Task (`tasks.conversation_id`), opened by its agent's first hand-over (`tasks/task/application/hand-over.ts`); a pipeline step visit reaches it through its Task. The domain knows nothing of Tasks or runs: they point at a conversation from above, and nothing here imports `tasks/` or `pipeline-executions/`. `agentMessageBody` (`domain/agent-message-body.ts`) cuts an agent's message to 10,000 characters.

## Tables

- `conversations`: `project_id`, a nullable `work_item_id`, `status` and `closed_at`. A conversation doesn't record who it waits on: Task reads work that out from the work item and the Task (`tasks/`).
- `conversation_messages`: `author_kind` (`agent`, `person` or `system`), `author_user_id` (null only for agent messages), `task_run_id` (the attempt that wrote an agent message), `delivered_to_task_run_id` (the attempt a person or system message reached) and `body` (trimmed, 1 to 20,000 characters, checked by the entity).

A conversation is separate from the work item's comments: nothing here writes a comment.

## Status

```
agent_turn ── the agent ends its turn ──→ waiting_for_person
waiting_for_person ── first person message, or continue ──→ reply_pending
reply_pending ── more person messages ──→ reply_pending
reply_pending ── deliverPendingMessages ──→ agent_turn
any ── the step visit ends ──→ closed
```

A conversation starts in `waiting_for_person`, opened by the agent's first hand-off. `ConversationEntity` enforces the rules; a person message outside `waiting_for_person` and `reply_pending`, or an action without writing (continue, Done) outside `waiting_for_person`, fails with `CONVERSATION_NOT_WAITING` (409).

## Writes

`application/send-conversation-message.ts`. Each locks the conversation row (`ConversationRepo.lock`), so it must run in a transaction:

- `sendConversationMessage`: a person's message, needing `comments:create` on the project. It returns the status before, so the caller knows whether it queued the agent's next turn.
- `postConversationSystemMessage`: a `system` message for an action a person took without writing ("Alex chose to continue without a reply"), with the conversation's next status. The caller checks permissions.
- `deliverPendingMessages(conversationId, taskRunId, deps, tx)`: hands every undelivered person and system message to `taskRunId` and moves the conversation to `agent_turn`. It does nothing unless the conversation is `reply_pending`. Once it runs, later messages are refused until the agent hands over again. The worker context runs it when a continuation fetches its context, and for a repo conversation (chat) on every run, found through the Task's `conversationId` (`tasks/task-run/application/task-run-worker-context-conversation.ts`). A chat's current turn is the person messages after the latest agent message, so a retry replays that turn whether or not it was already delivered.

Advancing the run on a message, continue or Done lives in `pipeline-executions/pipeline-run/application/conversation-and-advance.ts`, and the reads (with the visit and `endsWith`) in `get-conversation.ts` there. Agent messages and closing are written by the pipeline's command writer.

## Not built yet

- Conversations outside a pipeline step (standalone chats) and a `conversations:write` permission.
