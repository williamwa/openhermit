# Gateway

This app is the current OpenHermit control plane for managed multi-agent mode.

Current responsibilities:

- manage agent records from PostgreSQL
- start and stop `AgentRunner` instances in-process
- expose managed agent APIs behind `/agents/{id}/...`
- bridge WebSocket and SSE traffic to the selected runner
- provide the base URL used by channel adapters in gateway mode

Notes:

- standalone `apps/agent` still exists for direct single-agent operation
- the gateway no longer acts as a thin scaffold or a pure reverse proxy
- agent-local concepts such as sessions, approvals, and events are preserved; the gateway adds agent selection and lifecycle management
