---
id: device-auth-capability
title: Device Auth Capability
sidebar_label: Device Auth Capability
sidebar_position: 23
---

# Device Auth Capability

The Device Auth capability exposes a thin REST surface for managed
**device-code** authentication flows on plugins that authenticate via
the OAuth 2.0 Device Authorization Grant
([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)) — for
example, Claude Code OAuth, GitHub CLI auth, and similar
copy-the-code-into-your-terminal patterns.

The platform never owns the upstream OAuth provider's UI; instead, the
plugin is asked for a verification URL + user code, the platform shows
both to the user, and the user pastes the code into the provider's web
flow on their own device.

Source: `apps/api/src/plugins-capabilities/device-auth/`

## Architecture

```
DeviceAuthModule
  ├── DeviceAuthController        -- REST API endpoints
  ├── DeviceAuthService           -- Two-method passthrough
  └── PluginOperationsService     -- From @ever-works/agent/plugins
```

```typescript
@Module({
    imports: [AuthModule, PluginsModule],
    controllers: [DeviceAuthController],
    providers: [DeviceAuthService]
})
export class DeviceAuthModule {}
```

`DeviceAuthService` is two two-line methods: `getStatus(userId,
pluginId)` and `start(userId, pluginId)`. Both forward to
`PluginOperationsService.{getPluginDeviceAuthStatus,startPluginDeviceAuth}(pluginId,
userId)`. Errors propagate unwrapped — there is no
`BadRequestException` shaping at the HTTP layer.

> ⚠️ **Argument order**: the underlying service expects `pluginId`
> **first**, `userId` **second**. The controller's adapter swaps them
> back to put `userId` first, but if you call `DeviceAuthService`
> directly from another module, mind the order.

## API Endpoints

All endpoints are under `/api/device-auth` and require JWT
authentication via the global `AuthSessionGuard`.

### Get Status

```
GET /api/device-auth/:pluginId/status
Authorization: Bearer <jwt-token>
```

Returns the user-scoped device-auth status for a plugin. Safe to call
repeatedly (idempotent) — the UI uses this to poll while the user
completes the device flow on the provider's site.

**Path Parameters:**

| Name       | Type     | Description                                   |
| ---------- | -------- | --------------------------------------------- |
| `pluginId` | `string` | The plugin's id (e.g. `claude-code`, `codex`) |

**Response (`DeviceAuthStatus`):**

```json
{
    "installed": true,
    "connected": false,
    "pending": true,
    "scope": "user",
    "flowType": "device-code",
    "prompt": {
        "verificationUri": "https://github.com/login/device",
        "userCode": "ABCD-1234"
    },
    "message": "Visit the verification URL and enter the code to complete sign-in."
}
```

When the plugin has no in-flight session, `pending` is `false`,
`prompt` is omitted, and `message` describes the current state (e.g.
`"Not signed in"`, `"Already connected"`).

### Start

```
POST /api/device-auth/:pluginId/start
Authorization: Bearer <jwt-token>
```

Starts a fresh device-auth flow for the user. The response is the same
`DeviceAuthStatus` envelope — typically with `pending: true` and a new
`prompt` payload containing the `verificationUri` + `userCode` to show
the user.

The plugin is expected to:

1. Request a fresh device code from the upstream provider.
2. Store the device-code session (server-side) keyed by the user.
3. Begin polling the upstream provider's token endpoint at the
   provider-specified interval (typically 5–10 seconds).
4. Return the verification URI + user code immediately so the platform
   can display them.

The UI then calls `GET /status` on a timer until `pending` becomes
`false` and `connected` becomes `true` (or the flow times out / is
cancelled).

## DeviceAuthStatus Shape

```typescript
export interface DeviceAuthPrompt {
    verificationUri: string;
    userCode: string;
}

export interface DeviceAuthStatus {
    installed: boolean;            // Plugin loaded + advertises device-auth
    connected: boolean;            // User has a valid stored token
    pending: boolean;              // A device-code flow is in flight
    scope: 'user';                 // Always per-user (no global device flows)
    flowType: 'device-code';       // Discriminator for UI rendering
    prompt?: DeviceAuthPrompt;     // Present iff pending === true
    message: string;               // Human-readable status line
}
```

The `scope: 'user'` and `flowType: 'device-code'` literals are
intentionally narrow — they let the UI differentiate device-code flows
from other auth shapes (OAuth web redirect, PAT, etc.) at the type
level.

## Plugin Contract

To support this capability, a plugin must implement
[`IDeviceAuthProvider`](https://github.com/ever-works/ever-works/blob/develop/packages/plugin/src/contracts/capabilities/device-auth-provider.interface.ts):

```typescript
export interface IDeviceAuthProvider {
    getDeviceAuthStatus(userId: string): Promise<DeviceAuthStatus>;
    startDeviceAuth(userId: string): Promise<DeviceAuthStatus>;
    cancelDeviceAuth?(userId: string): Promise<DeviceAuthStatus>;
}
```

`cancelDeviceAuth` is optional. When it is implemented, the plugin
should invalidate the in-flight device-code session and return a
`DeviceAuthStatus` with `pending: false`. Today there is no HTTP
endpoint that surfaces `cancelDeviceAuth` — the cancel path is
internal-only and used by other workflows (e.g. when the user disables
the plugin mid-flow).

The capability registry detects this contract via `isDeviceAuthProvider`
(structural duck-typing on `getDeviceAuthStatus` + `startDeviceAuth`).

## Plugins That Use This Capability

| Plugin ID                | Provider                  | Notes                                                                |
| ------------------------ | ------------------------- | -------------------------------------------------------------------- |
| `claude-code`            | Claude Code OAuth          | User-scoped; surfaces `verification_uri_complete` + `user_code`     |
| `claude-managed-agent`   | Claude Code (managed)      | Same flow as `claude-code` but with a managed-agent context wrapper  |
| `codex`                  | OpenAI Codex CLI           | Device-code flow against the OpenAI auth endpoint                    |
| `gemini`                 | Gemini CLI                 | Google's device-code flow                                            |
| `opencode`               | OpenCode CLI               | Device-code flow against the OpenCode auth endpoint                  |

Each of these plugins ships its own settings schema for the resulting
token storage; the device-auth flow only handles the *acquisition* of
the token, not its long-term storage shape.

## Error Handling

Errors propagate unwrapped from the underlying `PluginOperationsService`.
Common failure modes:

| Scenario                              | What happens                                                                |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Plugin not installed / unloaded       | `PluginOperationsService` throws; the controller returns the original error |
| Plugin doesn't implement device-auth  | `PluginOperationsService` throws `Plugin does not support device auth`      |
| Upstream provider returns 4xx/5xx     | The plugin re-throws; the platform surfaces the message                     |

Unlike the deploy/search/screenshot capabilities, the device-auth
controller does NOT shape errors into `{status: 'error', message}`
envelopes — the response either succeeds (`DeviceAuthStatus`) or
the framework's default error handler returns a 500 with the original
message.

## Activity-Log Behaviour

No activity-log entries are emitted for device-auth operations. The
flow is high-frequency (status is polled while the user completes the
upstream flow) and the audit-volume cost outweighs the visibility gain.
A successful connection produces a regular `PLUGIN_CONFIGURED` log
entry indirectly when the resulting token is persisted via the plugin's
settings hooks (see [`activity-log`
spec](https://github.com/ever-works/ever-works/tree/develop/docs/specs/features/activity-log)).

## Source Files

| File                                                                       | Purpose                              |
| -------------------------------------------------------------------------- | ------------------------------------ |
| `apps/api/src/plugins-capabilities/device-auth/device-auth.module.ts`      | Module definition                    |
| `apps/api/src/plugins-capabilities/device-auth/device-auth.controller.ts`  | REST API controller                  |
| `apps/api/src/plugins-capabilities/device-auth/device-auth.service.ts`     | Thin two-method passthrough          |
| `packages/plugin/src/contracts/capabilities/device-auth-provider.interface.ts` | `DeviceAuthStatus` + `IDeviceAuthProvider` |
| `packages/agent/src/plugins/plugin-operations.service.ts`                   | `PluginOperationsService` orchestrator |
