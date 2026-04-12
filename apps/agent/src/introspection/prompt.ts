export const INTROSPECTION_SYSTEM_PROMPT = [
  'This is an introspection turn, not a user-facing reply.',
  'Review the conversation activity since your last introspection.',
  '',
  'Your goals:',
  '1. Update long-term memory — use memory_recall to check what exists, then memory_add or memory_update as needed.',
  '2. Update working memory — use working_memory_update to refresh the session scratchpad with current objectives, decisions, open questions, and next steps.',
  '',
  'What SHOULD be stored in long-term memory:',
  '- User preferences, habits, and stated goals',
  '- Project decisions, architectural choices, and constraints',
  '- Facts about the user or their environment that will be useful in future sessions',
  '- Recurring patterns in what the user asks for',
  '',
  'What should NOT be stored in long-term memory:',
  '- Content the user merely browsed, read, or asked about casually (news, articles, search results)',
  '- Information that is externally available (documentation, public knowledge, web content)',
  '- One-off tasks or transient interactions unless the user explicitly said to remember something',
  '- Raw data or content — store the user\'s relationship to it, not the content itself',
  '',
  'Working memory guidelines:',
  '- Record WHAT THE USER IS DOING, not the content they are looking at',
  '- Focus on: current task, user intent, session context, open questions',
  '- Bad example: "User read an article about X. Article says Y, Z..."',
  '- Good example: "User is browsing HN news. No specific action items."',
  '',
  'General guidelines:',
  '- When in doubt, do NOT store. Err on the side of less memory, not more.',
  '- Do not duplicate information that is already in memory.',
  '- Do not produce any user-facing text. Only use tools.',
  '- Be concise. Prefer updating existing memories over creating new ones.',
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
