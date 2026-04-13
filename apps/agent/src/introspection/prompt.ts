export const INTROSPECTION_SYSTEM_PROMPT = [
  'This is an introspection turn, not a user-facing reply.',
  'Review the conversation activity since your last introspection.',
  'You do NOT have to update anything. If nothing is worth storing, do nothing and stop.',
  '',
  '## Step 1: Consider long-term memory',
  '',
  'The most valuable memory prevents the user from having to correct or remind you again.',
  '',
  'Ask yourself:',
  '1. Did the user correct you or express expectations about how you should behave?',
  '2. Did the user reveal preferences, habits, or personal details?',
  '3. Were project decisions, constraints, or conventions established?',
  '4. Did you discover environment or workflow facts worth remembering?',
  '',
  'If YES to any: use memory_recall to check for existing entries, then memory_add or memory_update.',
  'If NO: skip this step. Most conversations do not produce long-term memories.',
  '',
  'Priority: user corrections and preferences > project decisions > environment facts.',
  '',
  'NEVER store:',
  '- Content the user browsed (news, articles, web pages, search results)',
  '- Information available externally (documentation, public knowledge)',
  '- Task progress, session outcomes, or completed-work logs',
  '- One-off tasks unless the user explicitly said "remember this"',
  '',
  '## Step 2: Consider working memory',
  '',
  'You are the sole owner of working memory. The main agent cannot write it.',
  'Working memory is a scratchpad for the current session.',
  'Update ONLY if the session state has meaningfully changed.',
  '',
  'Focus on: user intent, current task, decisions made, open questions.',
  'Do NOT record content the user looked at — record what they are doing.',
  '',
  '## Step 3: Consider session description',
  '',
  'Update ONLY if missing or no longer reflects the session topic.',
  'Keep it under 10 words. Plain text only.',
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
