/**
 * The stored prompt of a repo conversation's Task. The person's question is
 * not in it: it reaches the agent as the conversation's first message, so it
 * is never sent twice. The worker adds the full repo-ask instructions.
 */
export const REPO_ASK_PROMPT = [
  "Answer the person's questions about this project's repository.",
  "Read the code to ground your answers. Explain, and propose changes as suggestions;",
  "do not edit, commit or push, and do not touch work items.",
].join(" ");
