---
id: authentication
title: Authentication
sidebar_label: Authentication
sidebar_position: 2
---

# Authentication

The Ever Works API uses **JWT (JSON Web Token) Bearer authentication**. All endpoints are protected by default — only endpoints explicitly marked as public can be accessed without a token.

## Registration

Create a new account:

```bash
curl -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "your-password",
    "username": "myuser"
  }'
```

Returns access and refresh tokens on success.

## Login

Authenticate with email and password:

```bash
curl -X POST http://localhost:3100/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "your-password"
  }'
```

**Response:**

```json
{
	"accessToken": "eyJhbG...",
	"refreshToken": "eyJhbG..."
}
```

Use the `accessToken` in subsequent requests:

```
Authorization: Bearer eyJhbG...
```

## Token Refresh

Access tokens expire based on the `JWT_ACCESS_TOKEN_EXPIRATION` setting (default: 7 days). Use the refresh token to get a new access token:

```bash
curl -X POST http://localhost:3100/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "eyJhbG..."}'
```

Refresh tokens expire based on `JWT_REFRESH_TOKEN_EXPIRATION_DAYS` (default: 14 days).

## Logout

Invalidate a specific refresh token:

```bash
curl -X POST http://localhost:3100/api/auth/logout \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "eyJhbG..."}'
```

Invalidate all refresh tokens (logout from all devices):

```bash
curl -X POST http://localhost:3100/api/auth/logout-all \
  -H "Authorization: Bearer <access-token>"
```

## Profile

| Method | Endpoint                  | Description                     |
| ------ | ------------------------- | ------------------------------- |
| `GET`  | `/api/auth/profile`       | Get profile from JWT payload    |
| `GET`  | `/api/auth/profile/fresh` | Get fresh profile from database |
| `PUT`  | `/api/auth/profile`       | Update profile information      |

## Password Management

| Method | Endpoint                         | Auth     | Description                                 |
| ------ | -------------------------------- | -------- | ------------------------------------------- |
| `POST` | `/api/auth/update-password`      | Required | Change password (requires current password) |
| `POST` | `/api/auth/forgot-password`      | Public   | Request password reset email                |
| `POST` | `/api/auth/reset-password`       | Public   | Reset password with token from email        |
| `GET`  | `/api/auth/validate-reset-token` | Public   | Check if a reset token is valid             |

## Email Verification

| Method | Endpoint                         | Auth     | Description                            |
| ------ | -------------------------------- | -------- | -------------------------------------- |
| `POST` | `/api/auth/send-verification`    | Required | Send verification email                |
| `POST` | `/api/auth/verify-email`         | Public   | Verify email with token                |
| `GET`  | `/api/auth/validate-email-token` | Public   | Check if a verification token is valid |

## OAuth

The API supports OAuth authentication with GitHub and Google. OAuth endpoints are mounted at `/api/oauth/`.

### Get OAuth URL

Generate an authorization URL to redirect the user:

```bash
# GitHub
curl "http://localhost:3100/api/oauth/github/url?callbackUrl=http://localhost:3000/auth/callback"

# Google
curl "http://localhost:3100/api/oauth/google/url?callbackUrl=http://localhost:3000/auth/callback"
```

**Response:**

```json
{
	"url": "https://github.com/login/oauth/authorize?client_id=..."
}
```

### OAuth Callbacks

| Method | Endpoint                     | Description                            |
| ------ | ---------------------------- | -------------------------------------- |
| `GET`  | `/api/oauth/github`          | Initiate GitHub OAuth flow             |
| `GET`  | `/api/oauth/github/callback` | GitHub OAuth callback — returns tokens |
| `GET`  | `/api/oauth/google`          | Initiate Google OAuth flow             |
| `GET`  | `/api/oauth/google/callback` | Google OAuth callback — returns tokens |

### Plugin OAuth Connections

Plugins that require OAuth (e.g., GitHub for repository access) use a separate provider-agnostic OAuth flow. See [Other Modules — Plugin OAuth](/api/other-modules#plugin-oauth) for details.

## Configuration

JWT settings are configured via environment variables:

| Variable                            | Default | Description                                         |
| ----------------------------------- | ------- | --------------------------------------------------- |
| `JWT_SECRET`                        | —       | **Required.** Secret key for signing tokens         |
| `JWT_ACCESS_TOKEN_EXPIRATION`       | `7d`    | Access token TTL (e.g., `15m`, `1h`, `7d`, `never`) |
| `JWT_REFRESH_TOKEN_EXPIRATION_DAYS` | `14`    | Refresh token TTL in days (or `never`)              |
| `GH_CLIENT_ID`                      | —       | GitHub OAuth client ID                              |
| `GH_CLIENT_SECRET`                  | —       | GitHub OAuth client secret                          |
| `GOOGLE_CLIENT_ID`                  | —       | Google OAuth client ID                              |
| `GOOGLE_CLIENT_SECRET`              | —       | Google OAuth client secret                          |
