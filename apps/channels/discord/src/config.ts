export interface DiscordAdapterConfig {
  botToken: string;
  agentBaseUrl: string;
  agentToken: string;
}

export const loadConfig = async (): Promise<DiscordAdapterConfig> => {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) throw new Error('DISCORD_BOT_TOKEN environment variable is required.');

  const agentBaseUrl = process.env.OPENHERMIT_AGENT_URL ?? '';
  const agentToken = process.env.OPENHERMIT_AGENT_TOKEN ?? '';

  if (!agentBaseUrl || !agentToken) {
    throw new Error(
      'Agent connection required. Set OPENHERMIT_AGENT_URL + OPENHERMIT_AGENT_TOKEN.',
    );
  }

  return { botToken, agentBaseUrl, agentToken };
};
