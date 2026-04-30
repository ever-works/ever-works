---
id: deployment
title: Deployment API
sidebar_label: Deployment
sidebar_position: 5
---

# Deployment API

The Deployment API handles deploying directory websites to hosting providers. The API is provider-agnostic — it uses the active deployment plugin (e.g., Vercel) configured through the [plugin system](/plugin-system).

All endpoints require JWT authentication.

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/deploy/providers` | List available deployment providers |
| `GET` | `/api/deploy/providers/:providerId/configured` | Check if a provider is configured for the current user |
| `POST` | `/api/deploy/directories/:id` | Deploy a directory |
| `POST` | `/api/deploy/directories/:id/check` | Check if a directory can be deployed |
| `POST` | `/api/deploy/directories/:id/lookup` | Look up existing deployment status |
| `POST` | `/api/deploy/directories/:id/teams` | List deployment teams for a directory |
| `POST` | `/api/deploy/validate-token` | Validate the current user's deployment token |
| `POST` | `/api/deploy/teams` | List available deployment teams |
| `POST` | `/api/deploy/batch` | Deploy multiple directories at once |

## Deploy a Directory

Trigger a deployment for a specific directory:

```bash
curl -X POST http://localhost:3100/api/deploy/directories/:id \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"teamScope": "optional-team-id"}'
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `teamScope` | string | No | Deploy under a specific team |

## Check Deployment Capability

Check if the current user has the necessary provider configuration to deploy a directory:

```bash
curl -X POST http://localhost:3100/api/deploy/directories/:id/check \
  -H "Authorization: Bearer <token>"
```

## Validate Token

Validate the current user's configured deployment token:

```bash
curl -X POST http://localhost:3100/api/deploy/validate-token \
  -H "Authorization: Bearer <token>"
```

## Batch Deployment

Deploy multiple directories at once:

```bash
curl -X POST http://localhost:3100/api/deploy/batch \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "directories": [
      { "directoryId": "id-1", "teamScope": "optional-team" },
      { "directoryId": "id-2" }
    ],
    "teamScope": "optional-default-team"
  }'
```
