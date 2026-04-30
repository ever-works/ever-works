---
id: auth-commands
title: CLI Authentication Commands
sidebar_label: Auth Commands
sidebar_position: 3
---

# CLI Authentication Commands

The `auth` command group manages authentication for the Ever Works CLI. It supports browser-based OAuth login (default) and manual token entry, with credentials stored locally as JWT tokens.

## Architecture

```
apps/cli/src/commands/auth/
  index.ts                  # Commander auth command group
  login.command.ts          # Login via OAuth or manual token
  logout.command.ts         # Remove stored credentials
  status.command.ts         # Display auth status and verify token
  credentials.service.ts    # Credential storage and JWT validation
  oauth.service.ts          # Local HTTP server for OAuth callback
```

## Commands

### `ever-works auth login`

Authenticate with the Ever Works API. Defaults to browser-based OAuth; use `--manual` for direct token entry.

| Option              | Default                        | Description                |
|---------------------|--------------------------------|----------------------------|
| `--api-url <url>`   | `https://api.ever-works.com`   | API server URL             |
| `--manual`          | `false`                        | Skip OAuth, enter token manually |

**OAuth flow (default):**
1. Starts a local HTTP server on a dynamically assigned port (default: 44663)
2. Opens the browser to `{WEB_URL}/api/auth/authorize` with `redirect_uri`, `response_type=token`, and `client_id=cli`
3. User authenticates in the browser
4. The browser redirects to the local server with a `sessionToken` query parameter
5. The CLI verifies the token by fetching the user profile
6. Credentials are saved to `~/.ever-works/.credentials.json`
7. The local server renders a success HTML page and auto-closes after 15 seconds

The OAuth flow has a 5-minute timeout. If the browser does not open automatically, the authorization URL is printed to the terminal.

**Manual flow (`--manual`):**
1. Prompts for the API URL and an API token
2. Saves credentials without profile verification

If already logged in, the CLI prompts whether to proceed with a different account.

### `ever-works auth logout`

Remove stored credentials. Deletes `~/.ever-works/.credentials.json`.

### `ever-works auth status`

Display the current authentication status, including:

- Email and username (from JWT claims)
- Email verification status
- API URL
- Token expiry (days, hours, or minutes remaining)
- Live token verification against the API

If the stored token is expired or malformed, the credentials file is automatically removed.

## Credential Storage

`CredentialsService` manages a JSON file at `~/.ever-works/.credentials.json`:

```typescript
interface Credentials {
  token: string;        // JWT token
  apiUrl: string;       // API base URL
  email?: string;       // From JWT or profile
  username?: string;    // From JWT claims
  provider?: string;    // Auth provider
  emailVerified?: boolean;
  isActive?: boolean;
  avatar?: string | null;
  expiresAt?: string;   // ISO 8601 expiration
}
```

### Key Methods

| Method                  | Description                                              |
|-------------------------|----------------------------------------------------------|
| `get()`                 | Load and validate credentials; auto-removes if expired   |
| `save(credentials)`     | Write credentials to disk                                |
| `remove()`              | Delete the credentials file                              |
| `requireAuth()`         | Load credentials or exit with error message              |
| `createWithExpiry()`    | Build credentials from JWT token with extracted claims   |
| `getTokenExpiryInfo()`  | Calculate remaining time from JWT `exp` claim            |

### Validation on Load

When `get()` is called, the service validates:
1. File exists and contains a valid JSON object
2. Token is present and non-empty
3. Token has valid JWT structure (three dot-separated parts)
4. Token is not expired (via `isJWTExpired()`)
5. API URL is present (defaults to the configured `API_URL` constant)

If any check fails, the credentials file is silently removed and `null` is returned.

## OAuth Server Details

The local OAuth callback server (`oauth.service.ts`):

- Listens for a single request with a `sessionToken` or `error` query parameter
- Renders styled HTML pages for three states: `success`, `error`, and `waiting`
- Supports dark mode via `prefers-color-scheme` media query
- Tracks all connections and force-closes them after resolution
- Cross-platform browser opening via `open` (macOS), `start` (Windows), or `xdg-open` (Linux)
