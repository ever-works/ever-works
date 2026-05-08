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

## Authentication

All API endpoints require **JWT Bearer authentication** unless explicitly marked as public.

```
Authorization: Bearer <your-jwt-token>
```

Obtain a token by calling `POST /api/auth/login` or `POST /api/auth/register`. There are no API keys — all access is user-based via JWT tokens.

See [Authentication](/api/authentication) for the full auth flow.

## Rate Limiting

The API uses three rate-limiting tiers applied globally via NestJS Throttler:

| Tier       | Requests | Window     |
| ---------- | -------- | ---------- |
| **Short**  | 50       | 1 second   |
| **Medium** | 300      | 10 seconds |
| **Long**   | 1,000    | 60 seconds |

All tiers apply simultaneously. If any tier's limit is exceeded, the API returns `429 Too Many Requests`.

## Endpoint Groups

| Tag                 | Prefix                       | Description                                      | Details                                                                                 |
| ------------------- | ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Health**          | `/api`                       | Health check                                     | `GET /api` returns API status                                                           |
| **Auth**            | `/api/auth`                  | Registration, login, email verification          | [Authentication](/api/authentication)                                                   |
| **OAuth**           | `/api/oauth`                 | OAuth flows (GitHub, Google), plugin connections | [Authentication](/api/authentication), [Other Modules](/api/other-modules#plugin-oauth) |
| **Works**           | `/api/works`                 | Work CRUD, items, categories, generation, import | [Works](/api/works)                                                                     |
| **Deploy**          | `/api/deploy`                | Provider-agnostic deployment                     | [Deployment](/api/deployment)                                                           |
| **AI Conversation** | `/api/ai-conversations`      | Streaming AI chat                                | [AI Conversation](/api/ai-conversation)                                                 |
| **Git Providers**   | `/api/git-providers`         | Git provider connections, repos, orgs            | [Other Modules](/api/other-modules#git-provider-api)                                    |
| **Generator Form**  | `/api/generator-form`        | Dynamic pipeline form schemas                    | [Other Modules](/api/other-modules#generator-form-schema)                               |
| **Screenshot**      | `/api/screenshot`            | Screenshot capture                               | [Screenshot Capability](/api/screenshot-capability)                                     |
| **Search**          | `/api/search`                | Web search via the user's first configured plugin | [Search Capability](/api/search-capability)                                             |
| **Plugin Device Auth** | `/api/device-auth`        | Per-user device-code OAuth for plugins (CLI tools) | [Device Auth Capability](/api/device-auth-capability)                                  |
| **Subscriptions**   | `/api/subscriptions`         | Plans, billing, usage tracking                   | [Other Modules](/api/other-modules#subscriptions-api)                                   |
| **Notifications**   | `/api/notifications`         | User notifications                               | [Other Modules](/api/other-modules#notifications-api)                                   |
| **Members**         | `/api/works/:id/members`     | Work member management                           | [Works](/api/works)                                                                     |
| **Comparisons**     | `/api/works/:id/comparisons` | A vs B comparison page generation and management | [Works](/api/works)                                                                     |
| **Activity Log**    | `/api/activity-log`          | Per-user audit trail, filtering, CSV export       | [Activity Log](/api/activity-log)                                                       |
| **Templates**       | `/api/templates`             | Built-in / custom / forked template catalog       | [Template Catalog](/api/template-catalog)                                               |
| **Account**         | `/api/account`               | Export / import / GitHub-sync account data        | [Account Transfer](/api/account)                                                        |

## Request Format

- **Content-Type**: `application/json`
- **Body size limit**: 10 MB
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
