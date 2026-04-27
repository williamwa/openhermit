import { userInfo } from 'node:os';
import readline from 'node:readline';
import process from 'node:process';

import type { AgentLocalClient } from '@openhermit/sdk';

import { createCliSessionSpec } from './sessions.js';

/**
 * Probe the gateway's ownership state for the current CLI identity. If the
 * agent has no owner yet and we're not already owner, prompt the operator
 * to claim ownership. On success we re-open the session so the runner's
 * in-memory resolvedUserRole picks up the new role on the next request
 * (otherwise the user would still appear as 'guest' inside the chat).
 *
 * Runs BEFORE the TUI takes over the terminal, so plain stdout / readline
 * are safe.
 */
export const maybeClaimOwnership = async (opts: {
  agentId: string;
  gatewayUrl: string;
  token: string;
  /** SDK client for re-opening the session after a successful claim. */
  client: AgentLocalClient;
  sessionId: string;
}): Promise<void> => {
  const { agentId, gatewayUrl, token, client, sessionId } = opts;
  let osUser: string;
  try { osUser = userInfo().username; } catch { return; }

  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let probe: Response;
  try {
    probe = await fetch(
      `${gatewayUrl}/api/agents/${encodeURIComponent(agentId)}/ownership` +
        `?channel=cli&channelUserId=${encodeURIComponent(osUser)}`,
      { headers },
    );
  } catch {
    return; // best-effort; don't block chat
  }
  if (!probe.ok) return;

  const data = await probe.json().catch(() => null) as null | {
    hasOwner: boolean;
    owner: { userId: string; name: string | null } | null;
    me: { userId: string; role: string | null; name: string | null } | null;
  };
  if (!data || data.hasOwner || !data.me || data.me.role === 'owner') return;

  console.log(`\nAgent "${agentId}" has no owner yet.`);
  const yes = await askYesNo(`Claim ownership as "${osUser}"? [y/N]: `);
  if (!yes) {
    console.log('  declined; staying as guest.\n');
    return;
  }

  let promote: Response;
  try {
    promote = await fetch(
      `${gatewayUrl}/api/agents/${encodeURIComponent(agentId)}/users/${encodeURIComponent(data.me.userId)}/promote-to-owner`,
      { method: 'POST', headers },
    );
  } catch (err) {
    console.log(`  failed to claim: ${(err as Error).message}\n`);
    return;
  }
  if (!promote.ok) {
    const errBody = await promote.json().catch(() => ({})) as { error?: { message?: string } };
    console.log(`  failed to claim: ${errBody.error?.message ?? promote.status}\n`);
    return;
  }

  console.log(`  ✓ You are now owner of "${agentId}".\n`);

  // The runner cached resolvedUserRole='guest' during the first openSession
  // (which happened before the claim). Re-open so resolveSessionUser runs
  // again and picks up the fresh role from the DB.
  try {
    await client.openSession(createCliSessionSpec(sessionId));
  } catch {
    // Non-fatal — next user-driven request will reopen anyway.
  }
};

const askYesNo = (question: string): Promise<boolean> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
