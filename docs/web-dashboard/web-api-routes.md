---
id: web-api-routes
title: Web API Routes
sidebar_label: API Routes
sidebar_position: 30
---

# Web API Routes

## Overview

The Ever Works web application uses Next.js App Router API routes for operations that cannot be handled by server actions: streaming responses, OAuth callbacks, health checks, and authorization redirects. All API routes live in `apps/web/src/app/api/` and export HTTP method handlers (`GET`, `POST`). Unlike server actions, these routes handle raw HTTP requests/responses and are accessed via URL rather than direct function calls.

## Architecture

```
apps/web/src/app/api/
├── ai-conversations/
│   └── chat/
│       └── stream/
│           └── route.ts          # POST - Streaming AI chat responses
│
├── auth/
│   ├── authorize/
│   │   └── route.ts              # GET - Authorization with redirect
│   ├── reset-password/
│   │   └── route.ts              # Password reset token handling
│   └── verify-email/
│       └── route.ts              # Email verification token handling
│
├── health/
│   └── route.ts                  # GET - Health check endpoint
│
└── oauth/
    └── [providerId]/
        └── callback/
            ├── route.ts          # GET - OAuth login callback
            └── plugins/
                └── route.ts      # GET - Plugin OAuth callback
```

## Components

### AI Chat Stream

**File:** `apps/web/src/app/api/ai-conversations/chat/stream/route.ts`

**Method:** `POST`

This is the streaming endpoint consumed by the `useAIStream` hook and `ChatInterface` component. It proxies chat requests to the NestJS backend and streams the response back to the client as NDJSON.

**Request body:**

```typescript
{
    messages: Array<{ role: string; content: string }>;
    providerId?: string;
    model?: string;
    conversationId?: string;
}
```

**Response:** A streaming `Response` with `Content-Type: text/event-stream` or NDJSON. Each line is a JSON object containing a content chunk.

**Implementation:** The route handler:

1. Reads the request body.
2. Extracts the session token from cookies.
3. Calls `aiConversationAPI.streamChat(...)` which returns a readable stream from the backend.
4. Uses the `nextApiResponseStreaming` utility to pipe the backend stream directly to the client response.

This avoids buffering the entire response, enabling real-time token-by-token delivery to the browser.

```typescript
// Simplified implementation
export async function POST(request: Request) {
    const session = await getSession();
    if (!session) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const stream = await aiConversationAPI.streamChat(body, session.token);

    return nextApiResponseStreaming(stream);
}
```

**Client usage:**

```tsx
const { streamMessage } = useAIStream({ onComplete: handleComplete });
await streamMessage('/api/ai-conversations/chat/stream', {
    messages: conversationMessages,
    providerId: 'openai',
});
```

### Health Check

**File:** `apps/web/src/app/api/health/route.ts`

**Method:** `GET`

A minimal health check endpoint that returns a static JSON response. Used by monitoring systems, load balancers, and container orchestration to verify the web application is running.

**Response:**

```json
{
    "status": "OK",
    "message": "Application is healthy"
}
```

No authentication required. Returns HTTP 200 unconditionally.

```typescript
export async function GET() {
    return Response.json({
        status: 'OK',
        message: 'Application is healthy',
    });
}
```

### Authorization Redirect

**File:** `apps/web/src/app/api/auth/authorize/route.ts`

**Method:** `GET`

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `redirect_uri` | `string` | Where to redirect after authorization |
| `state` | `string` (optional) | State parameter to pass through |

This endpoint handles authorization flows where an external service needs to verify the user's identity. It:

1. Validates the `redirect_uri` against an allowlist of permitted redirect targets.
2. Checks that the user has a valid session.
3. Generates an authorization token or code.
4. Redirects the browser to the `redirect_uri` with the token appended as a query parameter.

If the user is not authenticated, they are redirected to the login page with the original authorization request preserved in the return URL.

### OAuth Login Callback

**File:** `apps/web/src/app/api/oauth/[providerId]/callback/route.ts`

**Method:** `GET`

**URL pattern:** `/api/oauth/:providerId/callback`

**Query parameters (from OAuth provider):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | `string` | Authorization code from the provider |
| `state` | `string` | CSRF state parameter |

This is the return URL for OAuth login flows (Google, GitHub). When a user completes authorization with the provider, they are redirected here. The route handler:

1. Extracts the `providerId` from the URL path (dynamic segment `[providerId]`).
2. Reads the `code` and `state` query parameters.
3. Validates the `state` against the `oauth_state` cookie set during the `connectProvider` server action (CSRF protection).
4. Calls the backend API with the authorization code to exchange it for access/refresh tokens.
5. Sets `access_token` and `refresh_token` cookies.
6. Cleans up the `oauth_state` cookie.
7. Redirects the user to `/dashboard`.

**Error handling:** If any step fails (invalid state, code exchange failure), the user is redirected to the login page with an error query parameter.

```typescript
// Simplified implementation
export async function GET(
    request: Request,
    { params }: { params: { providerId: string } }
) {
    const { providerId } = params;
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    // Validate CSRF state
    const storedState = cookies().get('oauth_state')?.value;
    if (state !== storedState) {
        return redirect('/login?error=invalid_state');
    }

    // Exchange code for tokens
    const result = await authAPI.oauthCallback(providerId, code);

    if (!result.success) {
        return redirect('/login?error=auth_failed');
    }

    // Set auth cookies
    cookies().set('access_token', result.accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
    });
    cookies().set('refresh_token', result.refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
    });

    // Cleanup
    cookies().delete('oauth_state');

    return redirect('/dashboard');
}
```

### Plugin OAuth Callback

**File:** `apps/web/src/app/api/oauth/[providerId]/callback/plugins/route.ts`

**Method:** `GET`

**URL pattern:** `/api/oauth/:providerId/callback/plugins`

A variant of the OAuth callback specifically for plugin OAuth connections (as opposed to login). When a plugin needs OAuth access (e.g., GitHub plugin accessing repositories), this callback handles the token exchange and stores the connection in the plugin's OAuth connection record rather than in the user's auth session.

The flow is similar to the login callback but:

- The resulting tokens are stored as a plugin OAuth connection, not as session cookies.
- The redirect target is the settings page for the relevant plugin rather than the dashboard.

## Implementation Details

### Streaming Utility

The `nextApiResponseStreaming` utility converts a backend readable stream into a Next.js `Response` with proper streaming headers:

```typescript
function nextApiResponseStreaming(backendStream: ReadableStream): Response {
    return new Response(backendStream, {
        headers: {
            'Content-Type': 'application/x-ndjson',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
```

This ensures the stream is not buffered by Next.js and is delivered to the client in real-time.

### Dynamic Route Segments

The OAuth callback uses Next.js dynamic segments (`[providerId]`) to handle multiple providers with a single route file. The provider ID is extracted from the `params` object:

```typescript
export async function GET(
    request: Request,
    { params }: { params: { providerId: string } }
) {
    // params.providerId is 'google', 'github', etc.
}
```

### Cookie Security

All authentication cookies are set with security flags:

| Flag | Value | Purpose |
|------|-------|---------|
| `httpOnly` | `true` | Prevents JavaScript access (XSS protection) |
| `secure` | `true` (production) | Only sent over HTTPS |
| `sameSite` | `'lax'` | CSRF protection while allowing OAuth redirects |
| `path` | `'/'` | Available to all routes |
| `maxAge` | Varies | Token-specific lifetime |

### API Route vs Server Action

The decision of when to use an API route vs a server action:

| Use API Route When | Use Server Action When |
|-------------------|----------------------|
| Streaming responses needed | Simple request/response |
| External OAuth callbacks | Form submissions |
| Health/status checks | Data mutations |
| Third-party webhooks | Client-initiated operations |
| Custom HTTP headers needed | Standard JSON responses sufficient |

## Styling & Theming

API routes have no visual component. They return JSON or streaming data. Error responses follow a consistent JSON shape:

```json
{
    "error": "Error message",
    "status": 401
}
```

## Usage Examples

### Consuming the Streaming Endpoint

```tsx
'use client';

import { useAIStream } from '@/lib/hooks/use-ai-stream';

export function ChatPanel() {
    const { streamMessage, isStreaming, content } = useAIStream({
        onComplete: (fullContent) => {
            // Save the completed message
            saveAssistantMessage(fullContent);
        },
    });

    const sendMessage = async (text: string) => {
        await streamMessage('/api/ai-conversations/chat/stream', {
            messages: [{ role: 'user', content: text }],
            providerId: 'openai',
        });
    };

    return (
        <div>
            {isStreaming && <p>{content}</p>}
            <textarea onKeyDown={handleEnterKey} />
        </div>
    );
}
```

### Health Check Integration

```bash
# Used by monitoring/orchestration
curl https://your-app.vercel.app/api/health
# Response: {"status":"OK","message":"Application is healthy"}
```

### OAuth Flow End-to-End

```
1. User clicks "Sign in with GitHub"
2. Client calls connectProvider('github') server action
3. Server action returns OAuth URL
4. Browser redirects to github.com/login/oauth/authorize?...
5. User authorizes on GitHub
6. GitHub redirects to /api/oauth/github/callback?code=...&state=...
7. Callback route validates state, exchanges code for tokens
8. Auth cookies are set
9. User is redirected to /dashboard
```

## Related Components

- [AI Components Deep Dive](./ai-components-deep-dive.md) - ChatInterface consumes the streaming endpoint
- [Web Hooks Reference](./web-hooks-reference.md) - useAIStream hook connects to the streaming route
- [Auth Components](./auth-components.md) - SocialLoginButtons initiate the OAuth flow that ends at callback routes
- [Server Actions Deep Dive](./server-actions-deep-dive.md) - Server actions handle the non-streaming data mutations
- [Settings Components](./settings-components.md) - Plugin OAuth uses the plugin callback route
