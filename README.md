# Cerberus — Container-per-Slack-Thread Orchestrator

Cerberus gives every Slack thread its own isolated agent container, managed by a single privileged orchestrator. Each Slack thread maps to exactly one running agent container that processes the conversation independently, with durable state persisted across container lifecycles.

## Quickstart

### Prerequisites

- **Docker** (20.10+) — for orchestrator, Redis, Postgres, and agent container spawning
- **pnpm** (8.0+) — for building and testing
- **Slack App** with Socket Mode enabled, configured with the following:
  - **OAuth scopes:** `app_mentions:read`, `chat:write`, `channels:history`, `reactions:write` (instant :eyes: "seen" ack)
  - **Socket Mode events:** `app_mention`, `message.channels`
  - **App-level tokens** with `connections:write` scope

### Setup

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Build the agent image:**
   ```bash
   pnpm build:agent-image
   ```

3. **Configure environment variables:**
   ```bash
   cd deploy
   cp .env.example .env
   # Edit .env to add your Slack tokens:
   #   SLACK_BOT_TOKEN=xoxb-...
   #   SLACK_APP_TOKEN=xapp-...
   ```

4. **Start the stack:**
   ```bash
   docker compose up --build
   ```

   The orchestrator will be available at `http://localhost:8080`.

5. **Mention the bot in Slack:**

   In any Slack channel, mention `@cerberus` in a thread or top-level message. The orchestrator will spawn a new agent container for that thread and the agent will respond.

   - **First mention:** A new `cerberus-agent-*` container is spawned; check via `docker ps`.
   - **Follow-up replies:** Routed to the same container; view progress with `docker compose logs -f orchestrator`.
   - **Metrics:** `curl http://localhost:8080/metrics` shows `cerberus_active_agents` and other observability data.
   - **Idle timeout:** Containers stop after 30 minutes of inactivity and are transparently recreated on the next message.

## Architecture

Cerberus implements an **actor model** for Slack conversations:

- **Thread** = durable actor (identity in Postgres, mailbox in Redis Streams)
- **Container** = disposable runtime (spawned on demand, stopped when idle)
- **Workspace** = persistent memory (filesystem volume per thread, survives container recreation)

### System overview

```
Slack Socket Mode
       ↓
┌─────────────────────────┐
│ Orchestrator (Docker)   │
│  - SlackGateway (Bolt)  │
│  - EventRouter          │
│  - ThreadSupervisor     │
│  - ThreadRegistry       │
│  - OutboxConsumer       │
└─────────┬───────────────┘
          ↓
    ┌─────────────────┐
    │ Redis Streams   │
    │ (mailbox/outbox)│
    └────────┬────────┘
             ↓
    ┌─────────────────┐
    │ Postgres        │
    │ (registry)      │
    └────────┬────────┘
             ↓
    ┌─────────────────┐
    │ Agent Containers│
    │ (per thread)    │
    └─────────────────┘
```

### Message flow

1. Slack delivers an event (mention or thread reply).
2. **SlackGateway** normalizes it; **EventRouter** deduplicates and derives the thread key.
3. **ThreadSupervisor** ensures a container is running (spawns if needed).
4. Message is added to `mailbox:<threadKey>` (mailbox-first: survives spawn latency).
5. Agent consumes the mailbox entry, processes with its brain, sends response to the shared `outbox`.
6. **OutboxConsumer** reads the outbox and posts the response back to Slack.

**Key guarantee:** Messages are never lost, even if the container crashes mid-processing — the mailbox consumer group redelivers unacked entries on restart.

### Security

- **Agents receive no Slack tokens or Docker socket** — only `REDIS_URL` (restricted ACL), `THREAD_KEY`, and workspace path.
- **Redis ACL** isolates `agent` users to their mailbox/outbox keys.
- **Orchestrator is the only privileged component** — it holds Slack tokens and controls the Docker socket.

For detailed architecture decisions, see [`docs/superpowers/specs/2026-07-18-cerberus-design.md`](docs/superpowers/specs/2026-07-18-cerberus-design.md). For high-level requirements, see [`spec.md`](spec.md).

## Testing

### Unit and integration tests

```bash
# Run all tests
pnpm test

# Run integration tests (spawns real Docker containers and services)
pnpm test:integration

# Watch mode
pnpm test --watch
```

Tests use vitest with in-memory fakes of every external dependency (Redis, Postgres, Docker). Integration tests use testcontainers to spin up real services.

### Build and image verification

```bash
# Build the orchestrator image
pnpm build:orchestrator-image

# Build the agent image
pnpm build:agent-image

# Verify images are available
docker images | grep cerberus
```

### Smoke test (manual)

Once `docker compose up --build` is running:

1. Mention the bot in a Slack channel: `@cerberus hello`
2. Watch orchestrator logs: `docker compose logs -f orchestrator`
3. Verify the container spawned: `docker ps | grep cerberus-agent`
4. Check metrics: `curl http://localhost:8080/metrics | grep cerberus_active_agents`
5. Reply in the thread without a mention: the same container should process it.
6. Wait 30+ minutes: the container stops (idle timeout).
7. Reply again: the container is recreated and resumes the conversation.

## Configuration

Environment variables (loaded from `deploy/.env` in production):

| Variable | Default | Notes |
|----------|---------|-------|
| `SLACK_BOT_TOKEN` | — | Required; Bot token (xoxb-...) |
| `SLACK_APP_TOKEN` | — | Required; App-level token (xapp-...) |
| `DATABASE_URL` | — | Postgres connection string; set by compose |
| `REDIS_URL` | — | Orchestrator's Redis connection; set by compose |
| `RUNTIME` | `docker` | `docker` for local dev; `k8s` for Kubernetes |
| `AGENT_NETWORK` | `cerberus-agents` | Docker network name for agent spawning |
| `AGENT_IMAGE` | `cerberus-agent:dev` | Image name for spawned agent containers |
| `AGENT_REDIS_URL` | — | Redis URL as reachable from agent containers |
| `IDLE_TIMEOUT_MS` | `1800000` | 30 minutes; containers stop after no activity |
| `MAX_CONCURRENT_AGENTS` | `50` | Backpressure cap; new threads queue if exceeded |
| `WORKSPACES_ROOT` | `/workspaces` | Mounted path where agent workspaces live |
| `WORKSPACES_HOST_ROOT` | — | Host path prefix for Docker bind mounts |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Project structure

```
cerberus/
  packages/
    protocol/          # Shared types and schemas for agent communication
    orchestrator/      # Slack gateway, registry, runtime, lifecycle
    agent/             # Agent container entry point
  deploy/
    docker-compose.yml # Local dev stack
    redis/users.acl    # Redis ACL for multi-user isolation
    .env.example       # Environment variable template
  docs/superpowers/specs/
    2026-07-18-cerberus-design.md  # Detailed architecture
  spec.md              # Original requirements
```

## Observability

### Logs

Structured JSON logs to stdout; each log line carries:
- `threadKey` — which thread (team-channel-timestamp)
- `correlationId` — event ID for tracing
- `level`, `timestamp`, `message`

View orchestrator logs:
```bash
docker compose logs -f orchestrator
```

### Metrics

Prometheus metrics exposed on `http://localhost:8080/metrics`:

- `cerberus_active_agents` — gauge of running agent containers
- `cerberus_agent_spawn_duration_ms` — histogram of spawn times
- `cerberus_mailbox_depth` — gauge of pending mailbox entries
- `cerberus_slack_message_latency_ms` — histogram of end-to-end latency

### Health

- `GET /healthz` — process is alive
- `GET /readyz` — Redis, Postgres, Docker runtime all reachable

## Troubleshooting

### Agent container not spawning

Check orchestrator logs for spawn errors:
```bash
docker compose logs orchestrator | grep spawn
```

Ensure Docker socket is accessible:
```bash
ls -la /var/run/docker.sock
```

### Slack messages not appearing

Verify Slack tokens are correct in `.env`.

Check if the outbox is stuck:
```bash
docker compose exec redis redis-cli --user orchestrator --pass orchestrator-dev-password XLEN outbox
```

View orchestrator metrics to see message latency:
```bash
curl http://localhost:8080/metrics | grep slack_message_latency
```

### Redis ACL errors

If agent containers fail with "NOAUTH" or permission errors, verify the ACL file is loaded:
```bash
docker compose exec redis redis-cli --user orchestrator --pass orchestrator-dev-password ACL LIST
```

It should show `user agent` with restricted key patterns.

## Deployment

For Kubernetes, the setup is nearly identical; switch `RUNTIME=k8s` and deploy Helm manifests in `deploy/k8s/`. The agent communication (Redis Streams) and orchestrator API are the same; only the container/pod spawning logic differs.

## Development

To modify the agent brain or orchestrator behavior:

1. Edit code in `packages/orchestrator` or `packages/agent`.
2. Rebuild images: `pnpm build:orchestrator-image && pnpm build:agent-image`
3. Restart the stack: `docker compose up --build`

To run tests after changes:
```bash
pnpm test
pnpm test:integration
```

## License

[Your license here]
