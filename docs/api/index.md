---
id: index
title: API Reference
sidebar_label: API Overview
sidebar_position: 1
---

# API Reference

The Ever Works Platform API is a REST API built with NestJS. It provides endpoints for authentication, work management, AI-powered content generation, deployment, and more.

## Base URL

```
http://localhost:3100    # Local development
```

## Interactive Documentation

| URL                 | Description                                |
| ------------------- | ------------------------------------------ |
| `/api/swagger`      | Swagger UI — interactive endpoint explorer |
| `/api/docs`         | Scalar API Reference — modern API docs UI  |
| `/api/openapi.json` | OpenAPI 3.0 JSON specification             |

Against a local API (`pnpm dev:api`) those are:

```bash
# Swagger UI          http://localhost:3100/api/swagger
# Scalar Reference    http://localhost:3100/api/docs
curl http://localhost:3100/api/openapi.json
```

The document is built from a single `DocumentBuilder` config — title `Ever Works API`,
version `1.0`, one `JWT-auth` bearer security scheme — shared by the running server and by
the build-time generator, so the two never drift.

:::caution The three docs URLs are disabled in production
Swagger UI, the Scalar reference, and `/api/openapi.json` are mounted only when
`NODE_ENV !== 'production'`; on a production deployment all three return `404`. The OpenAPI
document is a complete inventory of every route and DTO shape, so it is deliberately not
published. To obtain the spec for a production build, generate it offline instead:

```bash
pnpm build
pnpm --filter ever-works-api generate:openapi   # writes openapi.json
```

The generator runs Nest in preview mode — it introspects controllers without starting an
HTTP listener, connecting to the database, or reaching any external service. This is the
same artifact the MCP server image bundles.
:::

## Authentication

All API endpoints require authentication unless explicitly marked as public. The default
credential is **JWT Bearer authentication**; non-interactive clients can present an
[API key](#api-keys) instead, in the same `Authorization` header or in `x-api-key`.

```
Authorization: Bearer <your-jwt-token>
```

Obtain a token by calling `POST /api/auth/login` or `POST /api/auth/register`.

See [Authentication](/api/authentication) for the full auth flow.

### API Keys

Interactive clients use a session token. For everything that cannot open a browser — CI
pipelines, the CLI, the MCP server, cron jobs — the same API also accepts long-lived
**API keys**, so a machine integration never has to hold a password or refresh a token.

| Property       | Value                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| **Format**     | `ew_live_` + 64 hex characters (256 random bits) — 76 characters in total                                    |
| **Storage**    | SHA-256 hash; only the first 12 characters (`ew_live_` + 4 hex) are kept in clear as a label                 |
| **Limit**      | 10 _active_ keys per user — expired keys do not occupy a slot, and revoking frees one at once                |
| **Expiry**     | Optional `expiresAt`, which must be in the future at creation                                                |
| **Management** | `POST` / `GET` / `DELETE /api/auth/api-keys` — scoped to the calling user; authenticate with a session token |

Send the key in either header:

```bash
# Option 1 — x-api-key
curl http://localhost:3100/api/works \
  -H "x-api-key: ew_live_your_key_here"

# Option 2 — Authorization: Bearer
curl http://localhost:3100/api/works \
  -H "Authorization: Bearer ew_live_your_key_here"
```

The global auth guard treats the `ew_live_` prefix as the discriminator. If a value with
that prefix appears in either slot, the request takes the machine-credential path and
**never falls back** to session auth — a bad key returns `401 Invalid or expired API key`
instead of quietly authenticating as somebody else. Any other `Bearer …` value is parsed as
a session token. `lastUsedAt` advances on every successful key authentication.

:::note An API key carries the full rights of the user it belongs to
The key-management routes sit behind the same global auth guard as every other route, and
there is no session-only restriction on them. A request authenticated with an `ew_live_`
key can therefore create, list, and revoke keys as well — always within the account the key
was issued for, and never beyond it. Treat a key as equivalent to the account itself: scope
it with an `expiresAt`, keep it in a secrets manager, and prefer a session token for key
management so that a leaked key cannot quietly mint replacements for itself.
:::

:::tip Browser clients must use the `Authorization` header
CORS on the API allows only the `Content-Type` and `Authorization` request headers, so a
cross-origin browser client has to send `Authorization: Bearer ew_live_…`. The `x-api-key`
form is for server-side, CLI, and MCP callers.
:::

#### How to create an API key

1. Open **Settings → API Keys** at `/settings/api-keys` in the dashboard.
2. Click **Create API Key**, fill in **Name** (for example `CI Pipeline`) and an optional **Expiration**, then **Create**.
3. Click **Copy to clipboard** in the **API Key Created** dialog — the full key is shown exactly once and can never be retrieved afterwards — then **Done**.
4. Store it in a secrets manager or an environment variable. The MCP server reads it from `EVER_WORKS_API_KEY`, alongside `EVER_WORKS_API_URL` for the API base.
5. To retire a key, hit **Revoke** on its row. It stops working immediately, and any integration still using it starts getting `401`.

The same thing over the API, authenticated with a session token:

```bash
curl -X POST http://localhost:3100/api/auth/api-keys \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI Pipeline", "expiresAt": "2027-01-01T00:00:00Z"}'
```

Full reference, including the list and revoke payloads: [API Keys](/features/api-keys).

## Rate Limiting

The API uses three rate-limiting tiers applied globally via NestJS Throttler:

| Tier       | Requests | Window     |
| ---------- | -------- | ---------- |
| **Short**  | 50       | 1 second   |
| **Medium** | 300      | 10 seconds |
| **Long**   | 1,000    | 60 seconds |

All tiers apply simultaneously. If any tier's limit is exceeded, the API returns `429 Too Many Requests`.

## Endpoint Groups

| Tag                        | Prefix                       | Description                                        | Details                                                                                 |
| -------------------------- | ---------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Health**                 | `/api`                       | Health check                                       | `GET /api` returns API status                                                           |
| **Auth**                   | `/api/auth`                  | Registration, login, email verification            | [Authentication](/api/authentication)                                                   |
| **API Keys**               | `/api/auth/api-keys`         | Create, list, and revoke `ew_live_` API keys       | [API Keys](/features/api-keys)                                                          |
| **OAuth**                  | `/api/oauth`                 | OAuth flows (GitHub, Google), plugin connections   | [Authentication](/api/authentication), [Other Modules](/api/other-modules#plugin-oauth) |
| **Works**                  | `/api/works`                 | Work CRUD, items, categories, generation, import   | [Works](/api/works)                                                                     |
| **Deploy**                 | `/api/deploy`                | Provider-agnostic deployment                       | [Deployment](/api/deployment)                                                           |
| **AI Conversation**        | `/api/ai-conversations`      | Streaming AI chat                                  | [AI Conversation](/api/ai-conversation)                                                 |
| **AI — OpenAI-compatible** | `/api/v1`                    | OpenAI-format chat completions                     | [OpenAI-Compatible Chat Completions](#openai-compatible-chat-completions)               |
| **Git Providers**          | `/api/git-providers`         | Git provider connections, repos, orgs              | [Other Modules](/api/other-modules#git-provider-api)                                    |
| **Generator Form**         | `/api/generator-form`        | Dynamic pipeline form schemas                      | [Other Modules](/api/other-modules#generator-form-schema)                               |
| **Screenshot**             | `/api/screenshot`            | Screenshot capture                                 | [Screenshot Capability](/api/screenshot-capability)                                     |
| **Search**                 | `/api/search`                | Web search via the user's first configured plugin  | [Search Capability](/api/search-capability)                                             |
| **Plugin Device Auth**     | `/api/device-auth`           | Per-user device-code OAuth for plugins (CLI tools) | [Device Auth Capability](/api/device-auth-capability)                                   |
| **Subscriptions**          | `/api/subscriptions`         | Plans, billing, usage tracking                     | [Other Modules](/api/other-modules#subscriptions-api)                                   |
| **Notifications**          | `/api/notifications`         | User notifications                                 | [Other Modules](/api/other-modules#notifications-api)                                   |
| **Members**                | `/api/works/:id/members`     | Work member management                             | [Works](/api/works)                                                                     |
| **Comparisons**            | `/api/works/:id/comparisons` | A vs B comparison page generation and management   | [Works](/api/works)                                                                     |
| **Activity Log**           | `/api/activity-log`          | Per-user audit trail, filtering, CSV export        | [Activity Log](/api/activity-log)                                                       |
| **Templates**              | `/api/templates`             | Built-in / custom / forked template catalog        | [Template Catalog](/api/template-catalog)                                               |
| **Account**                | `/api/account`               | Export / import / GitHub-sync account data         | [Account Transfer](/api/account)                                                        |

## OpenAI-Compatible Chat Completions

`POST /api/v1/chat/completions` speaks the OpenAI chat-completions wire format. Any client
or SDK that lets you set a custom base URL can therefore talk to Ever Works with no bespoke
integration: point it at `http://localhost:3100/api/v1` and hand it an Ever Works credential
as the bearer token.

| Item             | Value                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Route**        | `POST /api/v1/chat/completions` — always answers `200`, never `201`                                                                                                                     |
| **Auth**         | The same two credentials as the rest of the API: a session token, or an `ew_live_` API key                                                                                              |
| **Body**         | `messages` (required), plus `model`, `temperature`, `max_tokens`, `top_p`, `frequency_penalty`, `presence_penalty`, `stop`, `stream`, `tools`, `tool_choice`, `response_format`, `user` |
| **Streaming**    | `"stream": true` returns `text/event-stream` SSE chunks, terminated by `data: [DONE]`                                                                                                   |
| **Tool calling** | `tools` / `tool_choice` go in; `tool_calls` come back on the assistant message, and `role: "tool"` results carrying a `tool_call_id` go back in                                         |
| **Extra fields** | Ignored rather than rejected — `stream_options`, `logprobs` and friends pass through harmlessly, unlike the rest of the API, which rejects unknown fields                               |

### Request headers

| Header                | Purpose                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `x-work-id`           | Run the completion in the context of one [Work](/api/works). Omit it and the API falls back to your first Work.                           |
| `x-provider-override` | Pin the AI provider plugin for this one call by plugin id (`openai`, `anthropic`, `openrouter`, …) instead of resolving it from settings. |

### Model selection

Send `"model": "auto"` — or omit `model` entirely — to let the platform resolve the model
from your configured AI-provider plugin. Any other value is passed to the provider as-is.
With no `x-provider-override`, the resolution order is the Work's active provider, then the
plugin marked default for the AI capability, then the first enabled one.

```bash
curl -X POST http://localhost:3100/api/v1/chat/completions \
  -H "Authorization: Bearer ew_live_your_key_here" \
  -H "Content-Type: application/json" \
  -H "x-work-id: <work-id>" \
  -d '{
    "model": "auto",
    "messages": [{ "role": "user", "content": "Draft a launch note for this directory." }]
  }'
```

The response is the standard OpenAI envelope: `object: "chat.completion"`, a `choices`
array carrying `message.content`, `message.tool_calls` and `finish_reason`, plus `usage`
with `prompt_tokens` / `completion_tokens` / `total_tokens` when the provider reports them.

Streaming is requested the same way as on the OpenAI API:

```bash
curl -N -X POST http://localhost:3100/api/v1/chat/completions \
  -H "Authorization: Bearer ew_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{ "stream": true, "messages": [{ "role": "user", "content": "Summarise my latest items." }] }'
```

### Knowledge Base mentions

When the request resolves to a Work, the endpoint scans the latest user message for `@kb:`
mentions, resolves each one against that Work's
[Knowledge Base](/features/knowledge-base), and prepends a `<kb>…</kb>` system message
carrying the matched documents — your own system prompt stays intact below it. The model is
asked to cite what it used inline as `kb:{class}/{slug}` (for example `kb:brand/voice`),
the same token shape the mention parser accepts, so citations round-trip.

Every degraded path is silent and harmless: no Work in scope, no mentions in the message, or
nothing resolvable simply sends the conversation through unchanged.

### Errors

Because this route writes to the response stream directly, it maps failures itself instead
of going through the standard exception envelope described below:

| Status | `error.type`           | When                                                                                          |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------- |
| `422`  | `provider_unavailable` | No AI provider is configured, or the request failed before any bytes were written             |
| `502`  | `provider_error`       | The provider failed after a streaming request started but before the first SSE chunk was sent |

A failure that happens mid-stream, once SSE bytes are already on the wire, destroys the
connection instead of emitting a misleading trailing JSON body — so treat an SSE stream that
ends without `data: [DONE]` as a failed completion.

## Request Format

- **Content-Type**: `application/json`
- **Body size limit**: 1 MB by default for JSON and form-encoded bodies. An operator can raise it with the `BODY_LIMIT` environment variable, which is capped at a 10 MB hard ceiling — a value above the cap, or one that does not parse, is rejected at boot and falls back to the 1 MB default.
- **File uploads** do not share that parser. They go through multer, with their own per-route limits.
- Input is validated with class-validator. Invalid fields return `400 Bad Request` with details.

## Error Responses

Errors follow a standard format:

```json
{
	"statusCode": 400,
	"message": ["field must be a string"],
	"error": "Bad Request"
}
```

Common status codes:

| Code  | Meaning               |
| ----- | --------------------- |
| `200` | Success               |
| `201` | Created               |
| `400` | Validation error      |
| `401` | Not authenticated     |
| `403` | Forbidden             |
| `404` | Not found             |
| `429` | Rate limit exceeded   |
| `500` | Internal server error |

## Related

- [Authentication](/api/authentication) — registration, login, refresh, and OAuth
- [API Keys](/features/api-keys) — the full lifecycle reference for `ew_live_` keys
- [AI Conversation API](/api/ai-conversation) — the platform-native streaming chat endpoint
- [Error Handling](/api/error-handling) — the shared exception envelope and status mapping
- [Guards & Interceptors](/api/guards-interceptors) — how requests are authenticated and scoped
- [MCP Server](/features/mcp-server) — the MCP surface, authenticated with an API key
- [Installation](/installation) — running the API locally and checking its health endpoints
