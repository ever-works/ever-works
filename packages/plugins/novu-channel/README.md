# @ever-works/novu-channel-plugin

Novu notification channel (workflow meta-router) for the Ever Works platform.

- **Capabilities**: `notification-channel`, `notification-channel-novu`
- **Shape**: `workflow` (Novu fans out across its own channel steps)
- **Transport**: Novu Trigger API (`POST /v1/events/trigger`, raw fetch — no `@novu/node` runtime dep)

## Settings (channel-level `targetConfig`)

| Key | Required | Description |
|-----|----------|-------------|
| `apiKey` | Yes | Novu API key (environment-scoped) |
| `workflowId` | Yes | Novu workflow trigger identifier (the `name` field) |
| `subscriberId` | Yes | Novu subscriber to deliver to |

## Plugin-level settings (tenant default)

| Key | Description |
|-----|-------------|
| `apiBase` | Novu API base — defaults to `https://api.novu.co`; set for self-hosted or the EU region (`https://eu.api.novu.co`) |

The `text` plus any `novu-payload` rich content is merged into the trigger
`payload`, available to the workflow's step templates. `providerMessageId`
is the Novu `transactionId`.

`verifyTarget` probes `GET /v1/environments/me` to confirm the API key.

Refs spec: [`docs/specs/features/notification-channels/spec.md`](../../../docs/specs/features/notification-channels/spec.md) §6.
