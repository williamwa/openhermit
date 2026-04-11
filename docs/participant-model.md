# Participant Model (Draft)

This document is a working draft.

It outlines a proposed model for separating connection role, participant identity, access relationship, and session routing in OpenHermit.

It is not yet the implemented source of truth.

## Why This Exists

OpenHermit will eventually need to support:

- local CLI and web clients
- paired users
- unpaired users
- channel adapters such as Telegram
- automation
- future nodes or device-side workers

Using a single `role` field for all of those concerns would mix together:

- who a participant is
- what a connection is allowed to do
- what relationship that participant has to the agent
- how messages should be routed into sessions

This draft separates those concerns into independent layers.

## Proposed Layers

### 1. Connection Role

Connection role describes what kind of system actor is connected right now.

Draft values:

- `owner_client`
- `user_client`
- `channel_adapter`
- `automation`
- `node`

This layer should drive:

- API permissions
- management capabilities
- approval behavior
- operator-only actions

It should not be used as the long-term identity of a human participant.

### 2. Participant Identity

Participant identity answers: who is this?

Draft shape:

```ts
interface ParticipantIdentity {
  id: string;
  kind: 'human' | 'agent' | 'service';
  displayName?: string;
  handles?: {
    cli?: string;
    telegram?: string;
    slack?: string;
  };
  externalRefs?: Array<{
    channel: string;
    accountId?: string;
    peerId: string;
  }>;
}
```

This layer should drive:

- memory ownership
- preference ownership
- audit attribution
- cross-channel identity linking
- multi-user separation

### 3. Participant Relationship

Relationship answers: what is this participant's relationship to the current agent?

Draft values:

- `owner`
- `paired`
- `member`
- `guest`
- `blocked`

This layer should drive:

- whether a participant may talk to the agent
- whether additional approval is needed
- whether the participant may modify agent identity or config
- default session-routing policy

This is more precise than overloading `role` to mean "owner vs stranger".

### 4. Session Routing

Session routing answers: where should this participant's messages go?

Draft values:

- `main`
- `per_identity`
- `per_channel_identity`
- `explicit`

This layer should drive:

- whether multiple participants share a thread
- whether the same person across channels shares a thread
- whether a client must explicitly choose a session

Suggested early defaults:

- local CLI owner: `main`
- local web owner: `main`
- external channel user: `per_identity`

## Message Attribution

Each inbound message should keep enough attribution to answer:

- who sent this
- through what channel
- under what system role
- with what relationship to the agent

Draft shape:

```ts
interface MessageActor {
  connectionRole: ConnectionRole;
  participantId?: string;
  relationship?: ParticipantRelationship;
  channel?: string;
}
```

This should be stored separately from assistant content so audit and policy logic can remain explicit.

## Memory Guidance

OpenHermit should keep these boundaries:

- agent identity and instructions are managed via the `InstructionStore` (bootstrapped from `workspace/.openhermit/*.md` on first boot)
- participant facts and preferences belong in named memory
- participant-specific memory should be keyed by participant identity

Examples:

- `participant/william/profile`
- `participant/william/preferences/communication`
- `participant/william/project/openhermit/context`

This avoids mixing participant knowledge into the agent's own identity files.

## Minimal First Implementation

A minimal version does not need the full model above.

Draft starter shape:

```ts
interface SessionParticipantContext {
  participantId?: string;
  relationship: 'owner' | 'paired' | 'guest';
  channel: 'cli' | 'web' | 'telegram' | 'api';
  routingMode: 'main' | 'per_identity';
}
```

Suggested immediate defaults:

- CLI: `participantId = local-owner`, `relationship = owner`, `channel = cli`, `routingMode = main`
- Web: `participantId = local-owner`, `relationship = owner`, `channel = web`, `routingMode = main`
- Future Telegram user: `participantId = telegram:<peerId>`, `relationship = paired | guest`, `channel = telegram`, `routingMode = per_identity`

## Open Questions

This draft intentionally leaves several questions open:

- should `owner_client` and `user_client` both remain connection roles, or should ownership move entirely into relationship?
- how should cross-channel identity linking be approved and stored?
- should participant identity live in internal state, gateway state, or both?
- what is the minimal session-routing model before Telegram and pair flows exist?
- how should participant-scoped memory be exposed to the runtime without leaking between identities?

## Current Status

Status: draft only.

Next steps:

1. Continue researching how OpenClaw handles sender identity, pairing, and session routing.
2. Decide the minimum participant context OpenHermit needs before channel adapters land.
3. Implement only the smallest structure needed for current local CLI and future pair/channel work.
