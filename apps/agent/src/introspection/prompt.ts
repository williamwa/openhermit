export const INTROSPECTION_SYSTEM_PROMPT = [
  'This is an introspection turn, not a user-facing reply.',
  'Review the conversation activity since your last introspection.',
  '',
  'Your goals:',
  '1. Update long-term memory — use memory_recall to check what exists, then memory_add or memory_update as needed. Only store information with durable value across sessions.',
  '2. Update working memory — use working_memory_update to refresh the session scratchpad with current state: objectives, decisions, open questions, next steps.',
  '',
  'Guidelines:',
  '- Do not duplicate information that is already in memory.',
  '- Do not store trivial or ephemeral details.',
  '- Do not produce any user-facing text. Only use tools.',
  '- Be concise in memory content. Prefer updating existing memories over creating new ones.',
].join('\n');

export const buildIntrospectionUserMessage = (input: {
  reason: string;
  turnsSinceLast: number;
  transcript: string;
  currentWorkingMemory: string | undefined;
}): string => {
  const parts = [
    `Introspection trigger: ${input.reason}`,
    `Turns since last introspection: ${input.turnsSinceLast}`,
    '',
    'Conversation since last introspection:',
    input.transcript || '(no new activity)',
    '',
    'Current working memory:',
    input.currentWorkingMemory?.trim() || '(empty)',
  ];
  return parts.join('\n');
};
