/**
 * The step prompt's section on handing the conversation back to a person by
 * ending a turn. A conversation step (no result schema) gets its own wording,
 * since there are no findings to submit. Left out when the step has no turns
 * left (`0`) or isn't part of a run (`null`).
 */
export function buildTurnGuidancePromptLines(input: {
  turnsRemaining: number | null;
  isConversationStep: boolean;
}): string[] {
  const { turnsRemaining } = input;
  if (turnsRemaining === null || turnsRemaining <= 0) return [];
  if (input.isConversationStep) {
    return [
      "",
      "This step is a conversation; there are no findings to submit. Each time you end your turn, your final message is sent to the person. When the conversation has reached its goal, call `scarn-end-conversation` and end your turn with a closing message. That message is posted on the work item as its summary, so write it for someone who wasn't in the conversation: what was decided and with whom, what you did, and links to the branch or pull request with your work.",
    ];
  }
  return [
    "",
    `If you're done, submit your findings. If you need something from a person, or they asked you something, end your turn: your final message is sent to them and you continue in this conversation when they reply. Ask only when the answer changes what you'd do and you can't find it in the repo, the work item or its comments. You can hand back ${String(turnsRemaining)} more ${turnsRemaining === 1 ? "time" : "times"}.`,
  ];
}
