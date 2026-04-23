import {
  pgTable,
  text,
  integer,
  serial,
  boolean,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const agents = pgTable('agents', {
  agentId: text('agent_id').primaryKey(),
  name: text('name'),
  configDir: text('config_dir').notNull(),
  workspaceDir: text('workspace_dir').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sessions = pgTable('sessions', {
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourcePlatform: text('source_platform'),
  interactive: integer('interactive').notNull(),
  createdAt: text('created_at').notNull(),
  lastActivityAt: text('last_activity_at').notNull(),
  description: text('description'),
  descriptionSource: text('description_source'),
  messageCount: integer('message_count').default(0).notNull(),
  completedTurnCount: integer('completed_turn_count').default(0).notNull(),
  lastMessagePreview: text('last_message_preview'),
  workingMemory: text('working_memory'),
  workingMemoryUpdatedAt: text('working_memory_updated_at'),
  metadataJson: text('metadata_json').default('{}').notNull(),
  status: text('status').default('idle').notNull(),
  type: text('type').default('direct').notNull(),
  userIdsJson: text('user_ids_json').default('[]').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.sessionId] }),
  index('idx_sessions_agent').on(table.agentId, table.lastActivityAt),
]);

export const sessionEvents = pgTable('session_events', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id').notNull(),
  ts: text('ts').notNull(),
  eventType: text('event_type').notNull(),
  payloadJson: text('payload_json').notNull(),
  content: text('content'),
  userId: text('user_id'),
}, (table) => [
  index('idx_session_events_agent_session').on(table.agentId, table.sessionId, table.ts),
  index('idx_session_events_type').on(table.agentId, table.sessionId, table.eventType, table.id),
]);

export const memories = pgTable('memories', {
  agentId: text('agent_id').notNull(),
  memoryKey: text('memory_key').notNull(),
  content: text('content').notNull(),
  metadataJson: text('metadata_json').default('{}').notNull(),
  createdAt: text('created_at').default('').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.memoryKey] }),
  index('idx_memories_agent').on(table.agentId, table.updatedAt),
]);

export const containers = pgTable('containers', {
  agentId: text('agent_id').notNull(),
  containerName: text('container_name').notNull(),
  containerType: text('container_type').notNull(),
  image: text('image').notNull(),
  status: text('status').notNull(),
  description: text('description'),
  metadataJson: text('metadata_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.containerName] }),
  index('idx_containers_agent').on(table.agentId, table.containerName),
]);

export const instructions = pgTable('instructions', {
  agentId: text('agent_id').notNull(),
  key: text('key').notNull(),
  content: text('content').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.key] }),
]);

export const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  name: text('name'),
  mergedInto: text('merged_into'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_users_updated').on(table.updatedAt),
]);

export const userAgents = pgTable('user_agents', {
  userId: text('user_id').notNull(),
  agentId: text('agent_id').notNull(),
  role: text('role').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.agentId] }),
  index('idx_user_agents_agent').on(table.agentId),
]);

export const userIdentities = pgTable('user_identities', {
  userId: text('user_id').notNull(),
  channel: text('channel').notNull(),
  channelUserId: text('channel_user_id').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.channel, table.channelUserId] }),
  index('idx_user_identities_user').on(table.userId),
]);

export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  path: text('path').notNull(),
  metadataJson: text('metadata_json').default('{}').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agentSkills = pgTable('agent_skills', {
  agentId: text('agent_id').notNull(),
  skillId: text('skill_id').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.skillId] }),
  index('idx_agent_skills_agent').on(table.agentId),
]);

export const schedules = pgTable('schedules', {
  agentId: text('agent_id').notNull(),
  scheduleId: text('schedule_id').notNull(),
  type: text('type').notNull(),
  status: text('status').default('active').notNull(),
  cronExpression: text('cron_expression'),
  runAt: text('run_at'),
  prompt: text('prompt').notNull(),
  sessionMode: text('session_mode').default('dedicated').notNull(),
  deliveryJson: text('delivery_json').default('"silent"').notNull(),
  policyJson: text('policy_json').default('{}').notNull(),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  runCount: integer('run_count').default(0).notNull(),
  consecutiveErrors: integer('consecutive_errors').default(0).notNull(),
  lastError: text('last_error'),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.scheduleId] }),
  index('idx_schedules_agent_status').on(table.agentId, table.status),
  index('idx_schedules_next_run').on(table.agentId, table.nextRunAt),
]);

export const scheduleRuns = pgTable('schedule_runs', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  scheduleId: text('schedule_id').notNull(),
  status: text('status').notNull(),
  sessionId: text('session_id'),
  prompt: text('prompt').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  durationMs: integer('duration_ms'),
  error: text('error'),
}, (table) => [
  index('idx_schedule_runs_schedule').on(table.agentId, table.scheduleId, table.startedAt),
]);
