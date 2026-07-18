# Container-per-Slack-Thread Architecture

## Goal

I want to evolve my Slack AI agent into a **container-per-thread architecture**.

The orchestrator itself runs inside Docker. It is the only component that communicates with Slack.

Whenever someone mentions the bot in Slack, I want a brand-new Docker container to be created that becomes responsible for that Slack thread.

Every Slack thread should map to exactly **one running agent container**.

Think of this similarly to how OpenClaw treats conversations, except instead of lightweight thread state, I want an isolated Docker container for each thread.

---

# High-Level Architecture

```text
Slack
        │
        ▼
┌──────────────────────┐
│ Orchestrator         │
│  - Slack API         │
│  - Thread Registry   │
│  - Docker Manager    │
└──────────┬───────────┘
           │
           ▼
      Docker Engine
           │
           ├──────────────┐
           │              │
           ▼              ▼
┌────────────────┐  ┌────────────────┐
│ Agent Thread A │  │ Agent Thread B │
└────────────────┘  └────────────────┘
```

The orchestrator owns:

- Slack Socket Mode / Events API
- Docker lifecycle
- Thread registry
- Authentication
- Posting replies back to Slack

The spawned agent containers **DO NOT** talk directly to Slack.

Instead, they communicate only with the orchestrator (or via Redis Streams if you think that is a better architecture).

---

# Desired Behaviour

When Slack sends an `app_mention`:

1. Determine the root `thread_ts`.
2. Build a unique thread key:

```
team_id + channel_id + thread_ts
```

3. Check whether an agent already exists.
4. If not:

   - create a Docker container
   - assign resource limits
   - mount a persistent workspace volume
   - pass thread metadata via environment variables
   - register the container

5. Forward the Slack message to that container.
6. Stream responses back through the orchestrator.
7. The orchestrator posts responses into the Slack thread.

Subsequent replies inside the same Slack thread should always be routed to the same agent container.

---

# Important Design Principle

Treat this system as an **Actor Model**, not simply "containers".

Each Slack thread is an actor.

The Docker container is merely the runtime for that actor.

This means:

- thread = durable identity
- mailbox = incoming Slack messages
- container = execution environment
- workspace = persistent memory

The actor should survive container restarts.

---

# Requirements

The orchestrator should:

- use **TypeScript**
- use **dockerode**
- communicate with Docker via `/var/run/docker.sock`
- maintain a thread registry

The registry should contain:

- threadKey
- containerId
- containerName
- status
- createdAt
- lastActivity
- workspacePath

The orchestrator should:

- automatically destroy idle containers after a configurable timeout
- recreate containers when needed
- support graceful shutdown
- deduplicate Slack events
- support thousands of concurrent Slack threads
- survive orchestrator restarts

---

# Agent Container

Each spawned container should:

- expose an HTTP API (or another protocol if you recommend something better)
- receive incoming Slack messages
- keep its own in-memory context
- optionally persist state into its mounted workspace
- be completely unaware of Slack
- never contain Slack credentials

Inputs should include:

- threadKey
- workspace path
- incoming message
- configuration
- MCP credentials (if needed)

Outputs should simply be responses for the orchestrator to post.

---

# Workspace

Each thread should own a persistent workspace:

```
/workspaces/<threadKey>/
```

Example:

```
/workspaces/T123-C456-1712345678/
    conversation.json
    state.json
    logs/
    repos/
    temp/
```

Destroying the container **must not** destroy the workspace.

The workspace should survive recreation.

---

# Lifecycle

New mention

↓

Spawn container

↓

Process Slack messages

↓

Idle for configurable timeout (e.g. 30 minutes)

↓

Stop container

↓

New Slack reply

↓

Recreate container

↓

Reconnect workspace

↓

Continue processing

---

# Communication

Please evaluate multiple communication mechanisms:

- HTTP
- Redis Streams
- NATS
- gRPC
- Unix sockets

Recommend whichever architecture scales best.

Explain your reasoning.

---

# Security

The orchestrator is the only component allowed to have:

- Slack Bot Token
- Slack App Token
- Docker socket
- orchestration privileges

The agent containers should run with:

- read-only filesystem
- dropped Linux capabilities
- no-new-privileges
- CPU limits
- memory limits
- PID limits

Only mount writable volumes where absolutely necessary.

---

# Persistence

Persistent state should live outside containers.

Possible approaches:

- SQLite
- Postgres
- Redis
- filesystem

Recommend the best combination.

Containers should be disposable.

Thread state should not be.

---

# Deliverables

Design this like a production-ready system.

I do **not** want just snippets.

I want a complete architecture.

Specifically include:

1. Architecture diagram
2. Sequence diagrams
3. Docker Compose layout
4. Project folder structure
5. TypeScript interfaces
6. Database schema
7. Docker manager implementation
8. Thread registry implementation
9. Lifecycle manager
10. Slack event router
11. Agent communication protocol
12. Recovery strategy
13. Logging
14. Metrics
15. Testing strategy
16. Configuration management
17. Future Kubernetes migration
18. Horizontal scaling strategy
19. Failure scenarios
20. Security review

---

# Coding Style

- TypeScript
- Strong typing
- Dependency Injection where appropriate
- SOLID principles
- Clean Architecture
- Event-driven design
- Production quality
- Extensible
- Well documented

---

# Goal

Design and implement a production-grade framework capable of supporting **thousands of concurrent Slack conversations**, where each Slack thread is backed by an isolated Docker container that can be safely stopped, recreated, and managed independently while preserving durable state.

When making architectural decisions, optimize for:

- fault tolerance
- scalability
- observability
- maintainability
- security
- extensibility

Act as the lead software architect for this project. Challenge any assumptions you think could be improved, explain trade-offs, and recommend better alternatives where appropriate.