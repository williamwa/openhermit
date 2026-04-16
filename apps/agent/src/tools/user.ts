import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type Toolset,
  type ToolContext,
  asTextContent,
  ensureAutonomyAllows,
  formatJson,
} from './shared.js';

const UserListParams = Type.Object({});

const UserIdentityLinkParams = Type.Object({
  user_id: Type.String({ description: 'Target user ID to link the identity to.' }),
  channel: Type.String({ description: 'Channel type (e.g. "telegram", "cli", "web", "discord").' }),
  channel_user_id: Type.String({ description: 'Platform-specific user ID.' }),
});

type UserIdentityLinkArgs = Static<typeof UserIdentityLinkParams>;

const UserIdentityUnlinkParams = Type.Object({
  channel: Type.String({ description: 'Channel type.' }),
  channel_user_id: Type.String({ description: 'Platform-specific user ID to unlink.' }),
});

type UserIdentityUnlinkArgs = Static<typeof UserIdentityUnlinkParams>;

const UserRoleSetParams = Type.Object({
  user_id: Type.String({ description: 'User ID to update.' }),
  role: Type.Union([
    Type.Literal('owner'),
    Type.Literal('user'),
    Type.Literal('guest'),
  ], { description: 'New role for the user.' }),
});

type UserRoleSetArgs = Static<typeof UserRoleSetParams>;

const UserMergeParams = Type.Object({
  from_user_id: Type.String({ description: 'User ID to merge from (will be marked as merged).' }),
  into_user_id: Type.String({ description: 'User ID to merge into (will receive identities).' }),
});

type UserMergeArgs = Static<typeof UserMergeParams>;

export const createUserListTool = (context: ToolContext): AgentTool<typeof UserListParams> => ({
  name: 'user_list',
  label: 'List Users',
  description: 'List all users with their identities and roles.',
  parameters: UserListParams,
  execute: async () => {
    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_list is unavailable: no user store is configured.');
    }

    const users = await context.userStore.list(context.storeScope);
    const result = await Promise.all(
      users.map(async (user) => {
        const identities = await context.userStore!.listIdentities(context.storeScope!, user.userId);
        return {
          ...user,
          identities: identities.map((i) => ({
            channel: i.channel,
            channelUserId: i.channelUserId,
          })),
        };
      }),
    );

    return {
      content: asTextContent(result.length > 0 ? formatJson(result) : 'No users found.\n'),
      details: { count: result.length, users: result },
    };
  },
});

export const createUserIdentityLinkTool = (context: ToolContext): AgentTool<typeof UserIdentityLinkParams> => ({
  name: 'user_identity_link',
  label: 'Link User Identity',
  description: 'Link a channel identity to a user. If the identity already belongs to another user, it will be re-linked to the target user.',
  parameters: UserIdentityLinkParams,
  execute: async (_toolCallId, args: UserIdentityLinkArgs) => {
    ensureAutonomyAllows(context.security, 'user_identity_link');

    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_identity_link is unavailable: no user store is configured.');
    }

    const userId = args.user_id.trim();
    const channel = args.channel.trim();
    const channelUserId = args.channel_user_id.trim();

    if (!userId || !channel || !channelUserId) {
      throw new ValidationError('user_identity_link requires non-empty user_id, channel, and channel_user_id.');
    }

    // Verify target user exists
    const user = await context.userStore.get(context.storeScope, userId);
    if (!user) {
      throw new ValidationError(`User not found: ${userId}`);
    }

    await context.userStore.linkIdentity(context.storeScope, {
      userId,
      channel,
      channelUserId,
      createdAt: new Date().toISOString(),
    });

    return {
      content: asTextContent(`Linked ${channel}:${channelUserId} to user ${userId}.\n`),
      details: { userId, channel, channelUserId },
    };
  },
});

export const createUserIdentityUnlinkTool = (context: ToolContext): AgentTool<typeof UserIdentityUnlinkParams> => ({
  name: 'user_identity_unlink',
  label: 'Unlink User Identity',
  description: 'Remove a channel identity link from its user.',
  parameters: UserIdentityUnlinkParams,
  execute: async (_toolCallId, args: UserIdentityUnlinkArgs) => {
    ensureAutonomyAllows(context.security, 'user_identity_unlink');

    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_identity_unlink is unavailable: no user store is configured.');
    }

    const channel = args.channel.trim();
    const channelUserId = args.channel_user_id.trim();

    if (!channel || !channelUserId) {
      throw new ValidationError('user_identity_unlink requires non-empty channel and channel_user_id.');
    }

    await context.userStore.unlinkIdentity(context.storeScope, channel, channelUserId);

    return {
      content: asTextContent(`Unlinked ${channel}:${channelUserId}.\n`),
      details: { channel, channelUserId },
    };
  },
});

export const createUserRoleSetTool = (context: ToolContext): AgentTool<typeof UserRoleSetParams> => ({
  name: 'user_role_set',
  label: 'Set User Role',
  description: 'Change a user\'s role (owner, user, or guest).',
  parameters: UserRoleSetParams,
  execute: async (_toolCallId, args: UserRoleSetArgs) => {
    ensureAutonomyAllows(context.security, 'user_role_set');

    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_role_set is unavailable: no user store is configured.');
    }

    const userId = args.user_id.trim();
    if (!userId) {
      throw new ValidationError('user_role_set requires a non-empty user_id.');
    }

    const user = await context.userStore.get(context.storeScope, userId);
    if (!user) {
      throw new ValidationError(`User not found: ${userId}`);
    }

    const updated = { ...user, role: args.role, updatedAt: new Date().toISOString() };
    await context.userStore.upsert(context.storeScope, updated);

    return {
      content: asTextContent(`Set role of user ${userId} to ${args.role}.\n`),
      details: { userId, role: args.role },
    };
  },
});

export const createUserMergeTool = (context: ToolContext): AgentTool<typeof UserMergeParams> => ({
  name: 'user_merge',
  label: 'Merge Users',
  description: 'Merge one user into another. All identities from the source user are moved to the target. The source user is marked as merged and excluded from listings.',
  parameters: UserMergeParams,
  execute: async (_toolCallId, args: UserMergeArgs) => {
    ensureAutonomyAllows(context.security, 'user_merge');

    if (!context.userStore || !context.storeScope) {
      throw new ValidationError('user_merge is unavailable: no user store is configured.');
    }

    const fromId = args.from_user_id.trim();
    const intoId = args.into_user_id.trim();

    if (!fromId || !intoId) {
      throw new ValidationError('user_merge requires non-empty from_user_id and into_user_id.');
    }
    if (fromId === intoId) {
      throw new ValidationError('Cannot merge a user into themselves.');
    }

    // Verify both users exist
    const fromUser = await context.userStore.get(context.storeScope, fromId);
    if (!fromUser) {
      throw new ValidationError(`Source user not found: ${fromId}`);
    }
    const intoUser = await context.userStore.get(context.storeScope, intoId);
    if (!intoUser) {
      throw new ValidationError(`Target user not found: ${intoId}`);
    }

    // Inherit name from source if target has none
    if (fromUser.name && !intoUser.name) {
      await context.userStore.upsert(context.storeScope, {
        ...intoUser,
        name: fromUser.name,
        updatedAt: new Date().toISOString(),
      });
    }

    await context.userStore.merge(context.storeScope, fromId, intoId);

    const parts = [`Merged user ${fromId} into ${intoId}. All identities have been transferred.`];
    if (fromUser.name && !intoUser.name) {
      parts.push(`Name "${fromUser.name}" inherited from source user.`);
    }

    return {
      content: asTextContent(parts.join('\n') + '\n'),
      details: { fromUserId: fromId, intoUserId: intoId },
    };
  },
});

// ── Toolset ────────────────────────────────────────────────────────

const USER_DESCRIPTION = `\
### User Management

You can manage users and their cross-channel identities. Only the owner can use these tools.

When the owner mentions linking identities or managing users, use these tools. For example:
- "that Telegram user is me" → find the user, then \`user_identity_link\` to your own user ID
- "give Bob user access" → \`user_role_set\`
- "who are my users?" → \`user_list\``;

export const createUserToolset = (context: ToolContext): Toolset => ({
  id: 'user',
  description: USER_DESCRIPTION,
  tools: [
    createUserListTool(context),
    createUserIdentityLinkTool(context),
    createUserIdentityUnlinkTool(context),
    createUserRoleSetTool(context),
    createUserMergeTool(context),
  ],
});
