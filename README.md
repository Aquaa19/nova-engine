# Nova Engine

WebSocket terminal PTY execution backend for Nova Code. Spawns, manages, and executes lightweight Docker sandboxes for students on demand.

## Prerequisites
- **Docker Engine** (Installed on host machine)
- **Docker Compose**
- **Node.js 18+** (If running locally without Docker)

---

## Environment Variables Configuration

Create a `.env` file at the root of `nova-engine`:

```bash
# General
PORT=3000
JWT_SECRET=your-super-long-secure-random-secret
LOG_LEVEL=info
LOG_FORMAT=json

# Sandbox Resource Limits
CONTAINER_MEMORY_MB=256
CONTAINER_CPUS=0.5
CONTAINER_PIDS_LIMIT=50
```

---

## Deployment Steps

To deploy the production configuration, run:

```bash
docker-compose -f docker-compose.prod.yml up -d --build
```

This will:
1. Build the production multi-stage image.
2. Mount the `/var/run/docker.sock` daemon so the engine can manage sandbox containers on the host.
3. Start the Node API on port `3000`.

---

## Observability & Health

- **Health Endpoint:** `GET /health`
  Returns current session count, uptime, and system version.
- **Prometheus Metrics:** `GET /metrics`
  Returns gauges and histograms for scraping active sessions, latency times, and server errors.
- **Logs:** Logs are formatted in structured JSON when `LOG_FORMAT=json`.

---

## Session Lifecycle and Automatic Cleanup
The engine has a built-in background cleanup thread running every 60 seconds:
- Automatically kills and removes Docker containers for sessions that have been idle for more than **30 minutes**.
- Enforces a maximum session duration of **120 minutes** (2 hours) per sandbox container.
