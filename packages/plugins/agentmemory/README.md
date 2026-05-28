# @ever-works/agentmemory-plugin

First-party implementation of the **agent-memory** capability for Ever
Works. Talks to a standalone [`agentmemory`](https://github.com/rohitg00/agentmemory)
REST server (the same one Claude Code / Codex / OpenCode / MCP clients
already use), so a single memory store can be shared across every
coding/generation agent the operator runs.

## Run modes

This plugin is deliberately mode-agnostic — same code, same settings,
three ways to deploy the backend:

| Mode | When | Setup |
|---|---|---|
| **Local dev** | You're hacking on Ever Works on a laptop. | `npx @agentmemory/agentmemory` in a separate terminal. The plugin's default `baseUrl` (`http://localhost:3111`) just works. |
| **Self-hosted in cluster** | You want the platform + memory store in the same k8s namespace. | Apply [`.deploy/k8s/agentmemory.optional.yaml`](../../../.deploy/k8s/agentmemory.optional.yaml) and set `baseUrl` to `http://agentmemory.<ns>.svc.cluster.local:3111`. |
| **Hosted** | You already run `agentmemory` elsewhere (a managed VM, a partner SaaS, your own cluster). | Set `baseUrl` to the HTTPS endpoint + `apiKey` to the server's `AGENTMEMORY_SECRET`. |

In every mode the Ever Works platform sees the same `IAgentMemoryPlugin`
contract — the `AgentMemoryFacadeService` dispatches to whichever plugin
the user / Work has resolved.

## Settings

| Key | Type | Scope | Env var fallback | Description |
|---|---|---|---|---|
| `baseUrl` | string | user | `AGENTMEMORY_BASE_URL` | REST endpoint. Default `http://localhost:3111`. |
| `apiKey` | secret | user | `AGENTMEMORY_API_KEY` | Bearer token. Empty is fine for a localhost dev server. Must match the server's `AGENTMEMORY_SECRET` env var. |
| `projectId` | string | work | — | Optional namespace inside the shared SQLite store. Lets two Works share one server without seeing each other's observations. |
| `timeoutMs` | number | user | — | Per-request timeout. Default 30s. |

## REST endpoints used

The plugin only hits the public, documented subset of agentmemory's
REST API:

- `GET  /agentmemory/health` — health + auth probe (also drives `validateConnection`).
- `POST /agentmemory/session/start`, `/session/end` — sessions.
- `POST /agentmemory/observe` — append in-session observations.
- `POST /agentmemory/remember` — persist long-term memory (no session).
- `POST /agentmemory/smart-search` — semantic + keyword search.
- `POST /agentmemory/context` — build prompt-injection context payload.
- `POST /agentmemory/forget` — governance / GDPR delete.
- `GET  /agentmemory/sessions` — list sessions.

## Tests

Vitest. 30 unit tests covering the HTTP client (auth header, error
translation, URL building) and the plugin class (settings validation,
routing /observe vs /remember, response normalisation across the
`results` / `matches` / `hits` field shapes agentmemory has shipped).

```bash
pnpm --filter @ever-works/agentmemory-plugin test
```

## Writing a different memory backend

Community plugins (`mem0`, `zep`, `langmem`, vector-DB-backed homegrown
stores) implement the same `IAgentMemoryPlugin` interface from
`@ever-works/plugin`. The facade doesn't care which one is selected —
follow this package's structure (settings schema with `x-secret` /
`x-envVar` extensions, `validateConnection` hits a real endpoint, raw /
typed response normalisation) and add the plugin to
`packages/plugins/<your-plugin>/`.
