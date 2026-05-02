---
id: other-modules
title: Other API Modules
sidebar_label: Other Modules
sidebar_position: 6
---

# Other API Modules

In addition to the core work and authentication APIs, the Ever Works Platform provides specialized modules for screenshots, deployment providers, subscriptions, and notifications.

## Screenshot API

The Screenshot API handles URL captures and image generation. It is provider-agnostic — the active screenshot plugin (ScreenshotOne, URLBox, Scrapfly, etc.) handles the actual capture.

### Endpoints

| Method | Endpoint                             | Description                                   |
| ------ | ------------------------------------ | --------------------------------------------- |
| `GET`  | `/api/screenshot/check-availability` | Check if a screenshot provider is configured  |
| `POST` | `/api/screenshot/capture`            | Capture a screenshot of a URL                 |
| `POST` | `/api/screenshot/get-url`            | Get a direct screenshot URL without capturing |

### Request Body

| Field                | Type    | Required | Description                        |
| -------------------- | ------- | -------- | ---------------------------------- |
| `url`                | string  | Yes      | URL to capture                     |
| `viewportWidth`      | number  | No       | Viewport width                     |
| `viewportHeight`     | number  | No       | Viewport height                    |
| `format`             | string  | No       | Image format: `png`, `jpg`, `webp` |
| `fullPage`           | boolean | No       | Capture full page                  |
| `delay`              | number  | No       | Delay before capture (ms)          |
| `blockAds`           | boolean | No       | Block ads                          |
| `blockTrackers`      | boolean | No       | Block trackers                     |
| `blockCookieBanners` | boolean | No       | Hide cookie consent banners        |

### Usage Example

```bash
curl -X POST http://localhost:3100/api/screenshot/capture \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "viewportWidth": 1280,
    "viewportHeight": 720,
    "format": "png"
  }'
```

## Git Provider API

The Git Provider API provides access to connected git providers (e.g., GitHub) for repository management. All endpoints require JWT authentication.

### Endpoints

| Method | Endpoint                                       | Description                                                  |
| ------ | ---------------------------------------------- | ------------------------------------------------------------ |
| `GET`  | `/api/git-providers`                           | List available git providers                                 |
| `GET`  | `/api/git-providers/:providerId/connection`    | Check git provider connection status                         |
| `GET`  | `/api/git-providers/:providerId/organizations` | List user's organizations                                    |
| `GET`  | `/api/git-providers/:providerId/repositories`  | List user's repositories (supports `?page=` and `?perPage=`) |
| `GET`  | `/api/git-providers/:providerId/user`          | Get git provider user info                                   |

## Plugin OAuth

Plugins that require OAuth connections (e.g., GitHub for repository access) use provider-agnostic OAuth endpoints. All endpoints require JWT authentication.

### Endpoints

| Method   | Endpoint                                  | Description                            |
| -------- | ----------------------------------------- | -------------------------------------- |
| `GET`    | `/api/oauth/providers`                    | List available OAuth providers         |
| `GET`    | `/api/oauth/:providerId/connection`       | Check OAuth provider connection status |
| `GET`    | `/api/oauth/:providerId/connect/url`      | Get OAuth authorization URL            |
| `GET`    | `/api/oauth/:providerId/callback/plugins` | OAuth callback handler                 |
| `GET`    | `/api/oauth/:providerId/user`             | Get OAuth provider user info           |
| `DELETE` | `/api/oauth/:providerId`                  | Disconnect OAuth provider              |

### Connect a Provider

```bash
# Get the authorization URL
curl "http://localhost:3100/api/oauth/github/connect/url?callbackUrl=http://localhost:3000/callback" \
  -H "Authorization: Bearer <token>"

# Returns: { "url": "https://github.com/login/oauth/authorize?..." }
```

## Generator Form Schema

Dynamic form schema endpoints return the configuration form for the active pipeline plugin, including all form fields, groups, and validation rules.

| Method | Endpoint                              | Description                              |
| ------ | ------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/generator-form`                 | Get global generator form schema         |
| `GET`  | `/api/works/:id/generator-form` | Get form schema for a specific work |

Both endpoints accept an optional `?pipelineId=` query parameter to get the form for a specific pipeline plugin.

## Subscriptions API

The Subscriptions API manages user plans and billing status.

### Endpoints

| Method | Endpoint                  | Description                          |
| ------ | ------------------------- | ------------------------------------ |
| `GET`  | `/api/subscriptions/plan` | Get current user's subscription plan |
| `POST` | `/api/subscriptions/plan` | Update user's subscription plan      |

### Plan Object

```json
{
	"code": "pro",
	"name": "Pro Plan",
	"allowedCadences": ["daily", "weekly"]
}
```

## Notifications API

The Notifications API manages in-app user notifications.

### Endpoints

| Method | Endpoint                          | Description                                |
| ------ | --------------------------------- | ------------------------------------------ |
| `GET`  | `/api/notifications`              | Get all notifications (supports filtering) |
| `GET`  | `/api/notifications/unread-count` | Get count of unread notifications          |
| `GET`  | `/api/notifications/persistent`   | Get critical/persistent notifications      |
| `POST` | `/api/notifications/:id/read`     | Mark a notification as read                |
| `POST` | `/api/notifications/read-all`     | Mark all notifications as read             |
| `POST` | `/api/notifications/:id/dismiss`  | Dismiss a notification                     |

### Filtering

You can filter notifications by adding query parameters:

- `unreadOnly=true`: Show only unread items
- `category=system`: Show only system notifications
- `limit=10`: Limit results (max 100)
- `offset=0`: Pagination offset

### Notification Categories

- `ai_credits`: AI usage alerts
- `subscription`: Billing and plan updates
- `generation`: Work generation status
- `system`: System-wide announcements
- `security`: Security alerts (logins, password changes)
