export const INTROSPECTION_SYSTEM_PROMPT = [
  'This is an introspection turn, not a user-facing reply.',
  'Review the conversation activity since your last introspection.',
  'You do NOT have to update anything. If there is nothing worth storing, do nothing and stop.',
  '',
  '## Step 1: Consider long-term memory (do this FIRST)',
  '',
  'Ask yourself: did the user reveal anything about themselves, their preferences,',
  'their projects, or their environment that would be useful in FUTURE sessions?',
  '',
  'If YES: use memory_recall to check for existing entries, then memory_add or memory_update.',
  'If NO: skip this step entirely. Most conversations do not produce long-term memories.',
  '',
  'Store ONLY:',
  '- User preferences, habits, and stated goals',
  '- Project decisions, architectural choices, and constraints',
  '- Facts about the user\'s environment or workflow',
  '',
  'NEVER store:',
  '- Content the user browsed or read (news, articles, web pages, search results)',
  '- Information available externally (documentation, public knowledge)',
  '- One-off tasks unless the user explicitly said "remember this"',
  '- Summaries of what happened in the conversation',
  '',
  '## Step 2: Consider working memory',
  '',
  'Working memory is a scratchpad for the current session. It should describe',
  'what the user is working on and what state the session is in.',
  '',
  'Update working memory ONLY if the session state has meaningfully changed.',
  'If the user is just chatting or browsing, a brief note is enough.',
  '',
  'Focus on: user intent, current task, decisions made, open questions.',
  'Do NOT record the content the user looked at — record what they are doing.',
  '',
  '## Step 3: Consider session description (do this LAST)',
  '',
  'The session description is a short title shown in session lists.',
  'Update it ONLY if the current description is missing or no longer reflects the session topic.',
  '',
  'Keep it under 10 words. Plain text only — no quotes, markdown, or punctuation.',
  'Focus on the main topic or goal, not individual actions.',
  '',
  '## Rules',
  '',
  '- When in doubt, do NOT store anything. Less is more.',
  '- Do not produce any user-facing text. Only use tools.',
  '- Be concise.',
].join('\n');

export const buildIntrospectionUserMessage = (input: {
  reason: string;
  turnsSinceLast: number;
  transcript: string;
  currentWorkingMemory: string | undefined;
  currentDescription: string | undefined;
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
    '',
    'Current session description:',
    input.currentDescription?.trim() || '(none)',
  ];
  return parts.join('\n');
};
