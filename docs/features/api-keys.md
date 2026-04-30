---
id: api-keys
title: API Keys
sidebar_label: API Keys
sidebar_position: 11
---

# API Keys

API keys provide a long-lived, non-interactive way to authenticate with the Ever Works API. They are ideal for CI/CD pipelines, CLI tools, MCP server connections, and any integration that cannot go through the browser-based JWT login flow.

:::tip When to use this
Use API keys whenever you need programmatic access to the API without user interaction — for example, connecting the MCP server, automating directory updates from a CI pipeline, or building custom integrations.
:::

## Prerequisites

- A registered Ever Works account
- Access to the Settings page in the Web Dashboard

## How It Works

1. **Create a key** — generate a new API key from the dashboard or via the API. The full key is shown only once.
2. **Store securely** — save the key in a secrets manager, environment variable, or `.env` file. It cannot be retrieved later.
3. **Authenticate** — pass the key in the `x-api-key` header or the `Authorization: Bearer` header on every API request.
4. **Validation** — the API hashes the key with SHA-256 and looks up the hash in the database. Expired or revoked keys are rejected.

## Key Format

| Part | Example | Description |
|------|---------|-------------|
| Prefix | `ew_live_` | Fixed prefix identifying Ever Works API keys |
| Secret | `a1b2c3d4...` | 64 random hex characters (256 bits) |
| Full key | `ew_live_a1b2c3d4e5f6...` | 76 characters total — shown only at creation |

After creation, only the first 12 characters (the display prefix) are stored in plain text. The full key is hashed and cannot be recovered.

## Authentication

API keys are accepted in two ways:

```bash
# Option 1: x-api-key header
curl http://localhost:3100/api/directories \
  -H "x-api-key: ew_live_your_key_here"

# Option 2: Authorization header
curl http://localhost:3100/api/directories \
  -H "Authorization: Bearer ew_live_your_key_here"
```

The API guard tries API key authentication first. If the value doesn't start with `ew_live_`, it falls back to JWT token validation.

## Limits

- Maximum **10 API keys** per user
- Optional expiration date (must be in the future when creating)
- `lastUsedAt` is updated automatically on each successful authentication

## API

All endpoints require JWT authentication (API keys cannot be used to manage other API keys).

### Create API Key

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/api-keys` | Generate a new API key |

```bash
curl -X POST http://localhost:3100/api/auth/api-keys \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CI Pipeline",
    "expiresAt": "2027-01-01T00:00:00Z"
  }'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Descriptive label (max 100 characters) |
| `expiresAt` | string | No | ISO 8601 expiration date (must be in the future) |

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "CI Pipeline",
  "key": "ew_live_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "prefix": "ew_live_a1b2",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "createdAt": "2026-03-06T12:00:00.000Z"
}
```

:::warning
The `key` field is only returned in this response. Copy it immediately and store it securely.
:::

### List API Keys

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/auth/api-keys` | List all API keys for the current user |

```bash
curl http://localhost:3100/api/auth/api-keys \
  -H "Authorization: Bearer <jwt-token>"
```

**Response:**

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "CI Pipeline",
    "prefix": "ew_live_a1b2",
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "lastUsedAt": "2026-03-06T14:30:00.000Z",
    "createdAt": "2026-03-06T12:00:00.000Z"
  }
]
```

The full key is never returned in list responses — only the display prefix.

### Revoke API Key

| Method | Endpoint | Description |
|--------|----------|-------------|
| `DELETE` | `/api/auth/api-keys/:id` | Revoke and permanently delete an API key |

```bash
curl -X DELETE http://localhost:3100/api/auth/api-keys/<key-id> \
  -H "Authorization: Bearer <jwt-token>"
```

Revoked keys are immediately invalid. Any requests using a revoked key will return `401 Unauthorized`.

## Related

- [Authentication](/api/authentication) — JWT login flow and token management
- [MCP Server](./mcp-server) — Uses API keys for authentication
