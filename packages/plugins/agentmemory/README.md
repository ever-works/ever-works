# @ever-works/agentmemory-plugin

First-party implementation of the **agent-memory** capability for Ever
Works. Talks to a standalone [`agentmemory`](https://github.com/rohitg00/agentmemory)
REST server (the same one Claude Code / Codex / OpenCode / MCP clients
already use), so a single memory store can be shared across every
coding/generation agent the operator runs.

## Run modes

This plugin is deliberately mode-agnostic — same code, same settings,
three ways to deploy the backend:

| Mode                       | When                                                                                      | Setup                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local dev**              | You're hacking on Ever Works on a laptop.                                                 | `npx @agentmemory/agentmemory` in a separate terminal. The plugin's default `baseUrl` (`http://localhost:3111`) just works.                                            |
| **Self-hosted in cluster** | You want the platform + memory store in the same k8s namespace.                           | Apply [`.deploy/k8s/agentmemory.optional.yaml`](../../../.deploy/k8s/agentmemory.optional.yaml) and set `baseUrl` to `http://agentmemory.<ns>.svc.cluster.local:3111`. |
| **Hosted**                 | You already run `agentmemory` elsewhere (a managed VM, a partner SaaS, your own cluster). | Set `baseUrl` to the HTTPS endpoint + `apiKey` to the server's `AGENTMEMORY_SECRET`.                                                                                   |

In every mode the Ever Works platform sees the same `IAgentMemoryPlugin`
contract — the `AgentMemoryFacadeService` dispatches to whichever plugin
the user / Work has resolved.

## Settings

| Key         | Type   | Scope | Env var fallback       | Description                                                                                                   |
| ----------- | ------ | ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `baseUrl`   | string | user  | `AGENTMEMORY_BASE_URL` | REST endpoint. Default `http://localhost:3111`.                                                               |
| `apiKey`    | secret | user  | `AGENTMEMORY_API_KEY`  | Bearer token. Empty is fine for a localhost dev server. Must match the server's `AGENTMEMORY_SECRET` env var. |
| `projectId` | string | work  | `AGENTMEMORY_PROJECT`  | Namespace sent as `project` on every request (agentmemory requires it). Defaults to `ever-works` when unset.  |
| `timeoutMs` | number | user  | —                      | Per-request timeout. Default 30s.                                                                             |

## REST endpoints used

The plugin only hits the public, documented subset of agentmemory's
REST API:

- `GET  /agentmemory/health` — health + auth probe (also drives `validateConnection`).
- `POST /agentmemory/session/start`, `/session/end` — sessions; both require `project`.
- `POST /agentmemory/remember` — persist a memory record (`{ project, content, tags?, metadata?, sessionId? }`).
- `POST /agentmemory/smart-search` — semantic + keyword search (`{ project, query, topK? }`).
- `POST /agentmemory/context` — build prompt-injection context payload (`{ project, query?, tokenBudget? }`).
- `POST /agentmemory/forget` — governance / GDPR delete (`{ project, filter: { id } }`).

`/agentmemory/observe` is **not** used: the upstream server validates
`type` + `payload` against an auto-capture hook shape (PostToolUse etc.)
that doesn't fit free-form platform saves. We always route `saveMemory`
through `/remember`, attaching `sessionId` as metadata so audit trails
can still link the memory back to its session.

## Tests

Vitest. 40 unit tests covering the HTTP client (auth header, error
translation, URL building) and the plugin class (settings validation,
required-`project`/`topK`/`tokenBudget` mapping, env-var fallback,
missing-id surfacing, response normalisation across the `results` /
`matches` / `hits` field shapes agentmemory has shipped).

```bash
pnpm --filter @ever-works/agentmemory-plugin test
```

## Writing a different memory backend

Community plugins (`mem0`, `zep`, `langmem`, vector-DB-backed homegrown
stores) implement the same `IAgentMemoryPlugin` interface from
`@ever-works/plugin`. The facade doesn't care which one is selected —
follow this package's structure (settings schema with `x-secret` for
secrets, manual env-var fallback in `resolveSettings` rather than
`x-envVar` which would lock the field out of the admin UI,
`validateConnection` hits a real endpoint, raw / typed response
normalisation) and add the plugin to `packages/plugins/<your-plugin>/`.
