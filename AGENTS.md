# OmniRoute — Deployment & Operations

**Purpose**: Deployment architecture, service management, and operational knowledge for the OmniRoute AI proxy on `api.ssoni.net`.

---

## Deployment Architecture

```
Internet → nginx :443 → proxy_pass → standalone server :20128
```

- **nginx** handles TLS termination at `api.ssoni.net`, proxies to backend.
- **Standalone server** (`node .next/standalone/server.js`) is the Next.js production build via `output: standalone` config.
- **Database**: `/home/deploy/OmniRoute-deploy/data/storage.sqlite` — SQLite with WAL journaling.
- **Node**: v22.14.0, managed via NVM. The build step compiles under the system Node (v26.1.0), then `better-sqlite3` is recompiled for v22.14.0 at runtime.

## Service Management

| Command                                               | Effect                     |
| ----------------------------------------------------- | -------------------------- |
| `sudo systemctl start/stop/restart omniroute.service` | Control the backend server |
| `sudo systemctl enable/disable omniroute.service`     | Boot-time auto-start       |
| `sudo journalctl -u omniroute.service -n 50 -f`       | Tail logs                  |
| `sudo systemctl status omniroute.service`             | Quick health check         |

The service runs the standalone server directly — NOT `npm run start`/`run-next.mjs` (which hangs with `output: standalone`). The old systemd unit that used `npm run start` was replaced.

## Service Unit (/etc/systemd/system/omniroute.service)

Key details:

- **User**: `deploy` (not root)
- **WorkingDirectory**: `/home/deploy/OmniRoute-deploy`
- **ExecStart**: Activates nvm, switches to Node 22.14.0, runs `node .next/standalone/server.js`
- **DATA_DIR**: Explicitly set to `/home/deploy/OmniRoute-deploy/data` (the standalone server does NOT auto-detect this from WorkingDirectory)
- **Restart**: `always` with 10s delay — survives crashes
- **Port**: 20128

## Build & Deploy

```
# Set up nvm
source /home/deploy/.nvm/nvm.sh && nvm use 22.14.0

# The build is done under system Node (v26). After build, rebuild better-sqlite3 for v22:
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh" && nvm use 22.14.0
npm rebuild better-sqlite3

# Full rebuild
npm run build
npm rebuild better-sqlite3    # again for v22
sudo systemctl restart omniroute.service
```

The native module `better-sqlite3` must match the RUNTIME Node version. The build step uses system Node (v26) and recompiles the module for v26. After rebuilding for v22, the service runs. When a system Node upgrade happens, repeat: `npm rebuild better-sqlite3`.

**If the server was accidentally started outside systemd** (e.g. via nohup) and holds port 20128:

```
sudo kill $(fuser 20128/tcp)
sudo systemctl restart omniroute.service
```

## Data Directory

The `data/` directory was created by Docker (running as root). Permissions were fixed with `sudo chown -R deploy:deploy data/`. Future Docker operations risk reverting ownership — re-run the chown if `SQLITE_READONLY_DIRECTORY` errors appear.

## Key Bugfixes Applied

### 1. Implicit Streaming (crof.ai / openai-compatible)

**File**: `open-sse/executors/default.ts` — `DefaultExecutor.transformRequest()`
**What**: Added `stream: true` to the upstream body when streaming is inferred from `Accept` header but body omits the field. Some providers (crof.ai) require explicit `"stream":true` in the body and do not infer it from `Accept: text/event-stream`.
**Change**: Inside the `else if (stream && targetFormat === "openai" && requestFormat !== "openai-responses")` block, added `if (!withDefaults.stream) withDefaults = { ...withDefaults, stream: true };`.

### 2. Catalog Vision Capabilities

**File**: `src/lib/modelMetadataRegistry.ts` — `enrichCatalogModelEntry()`
**What**: Added fallback that checks `supported_endpoints` for `"images"` to set `vision: true` when models.dev data, registry, and heuristics all lack a definitive boolean.
**Also**: `src/app/api/v1/models/catalog.ts` — pre-populates `capabilities` from `SyncedAvailableModel.supportsVision/Thinking/Audio/Video` fields.

### 3. Route-layer Stream Guard

**File**: `src/app/api/v1/chat/completions/route.ts`
**What**: Reads the body before `handleChat()`, injects `stream: true` when body omits it and `Accept` doesn't request `application/json`. Creates a new `Request` with the modified body. (Belt-and-suspenders — the executor fix should suffice, but this catches any path where the executor doesn't run.)

## Database

### Key Tables

| Table                      | Purpose                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `provider_connections`     | OAuth/API key provider connections with encrypted credentials                  |
| `key_value`                | KV store for `syncedAvailableModels`, `customModels`, and system settings      |
| `modelAliases`             | Maps model IDs (e.g. `crf/kimi-k2.6-precision` → internal provider model keys) |
| `call_logs`                | Per-request logs with status, model, provider, timing                          |
| `combos` / `combo_targets` | Multi-model routing configurations                                             |

### Provider Connection Pattern

A custom provider like `crf` (crof.ai) creates:

1. A `provider_connections` row with encrypted API key, `provider_specific_data` JSON (prefix, baseUrl, apiType, nodeName)
2. A `provider_nodes` row mapping the prefix `crf` to the connection
3. `key_value` entries in `syncedAvailableModels` and `customModels` with model metadata

Model aliases (key: `openai-compatible-chat-7068c33a-...`) live in the `modelAliases` table and map user-facing IDs like `crf/kimi-k2.6-precision` to the internal provider model key.

## Streaming Fix Debugging

When the streaming fix compiles into `.next/server/chunks/` but doesn't take effect:

1. Check that the server is ACTUALLY serving the new chunks — Docker containers or stale nohup processes may serve old code.
2. The build uses Turbopack; chunk filenames change between builds but `route.js` references the correct ones.
3. If `curl localhost:[port]` returns HTTP 200 but body is empty, the standalone server may need `DATA_DIR` set to find the database.
4. The `run-next.mjs` script (from `npm run start`) does NOT work with `output: standalone` — use `node .next/standalone/server.js` directly.

## nginx Config

File: `/etc/nginx/sites-available/api.ssoni.net`
Proxies `https://api.ssoni.net` → `http://127.0.0.1:20128`. SSE support via `proxy_buffering off`, 86400s timeouts.

---

## Key Decisions

- **Standalone over `next start`**: The `next.config.mjs` uses `output: standalone`. `next start` refuses to work with this config (hangs, never binds). Always deploy via `node .next/standalone/server.js`.
- **Docker removed**: The previous Docker-based deployment was stopped. The systemd service now runs the standalone server directly.
- **NVM for Node version management**: System has Node v26 (for build). Production runs v22.14.0. The service script activates nvm before running.
- **DATA_DIR override required**: The standalone server embeds a build-time `DATA_DIR` path. On this host it must be set explicitly via env var.
- **AGENTS.md for future sessions**: This file captures architectural knowledge, deployment procedures, and bugfix context so future agent sessions can onboard quickly.
