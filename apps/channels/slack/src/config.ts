export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  agentBaseUrl: string;
  agentToken: string;
}

export const loadConfig = async (): Promise<SlackAdapterConfig> => {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken) throw new Error('SLACK_BOT_TOKEN environment variable is required.');
  if (!appToken) throw new Error('SLACK_APP_TOKEN environment variable is required (xapp-...).');

  const agentBaseUrl = process.env.OPENHERMIT_AGENT_URL ?? '';
  const agentToken = process.env.OPENHERMIT_AGENT_TOKEN ?? '';

  if (!agentBaseUrl || !agentToken) {
    throw new Error(
      'Agent connection required. Set OPENHERMIT_AGENT_URL + OPENHERMIT_AGENT_TOKEN.',
    );
  }

  return { botToken, appToken, agentBaseUrl, agentToken };
};
