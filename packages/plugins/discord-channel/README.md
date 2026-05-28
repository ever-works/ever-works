# @ever-works/discord-channel-plugin

Discord notification channel for the Ever Works platform.

- **Capabilities**: `notification-channel`, `notification-channel-discord`
- **Shape**: `broadcast` (Discord channels = broadcast surfaces)
- **Transport**: incoming webhook URL (v1) — a plain HTTPS POST via `fetch`
- **Bot-token mode**: planned for a future iteration

> **SDK note:** intentionally uses `fetch`, not a vendor SDK. Discord incoming webhooks are a bare URL POST with no official SDK; `discord.js` is a full gateway/bot client (WebSocket connection, intents, caches) — far too heavy for a one-shot notification POST. The SDK rule applies where a _sensible_ vendor SDK exists (cf. slack-channel → `@slack/webhook`, telegram-channel → `grammy`).

## Settings (channel-level `targetConfig`)

| Key          | Required | Description                               |
| ------------ | -------- | ----------------------------------------- |
| `webhookUrl` | Yes      | Discord channel incoming webhook URL      |
| `username`   | No       | Override sender username for this channel |
| `avatarUrl`  | No       | Override sender avatar for this channel   |

## Plugin-level settings (tenant default)

| Key                | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `defaultUsername`  | Fallback username when channel config doesn't override |
| `defaultAvatarUrl` | Fallback avatar when channel config doesn't override   |

Refs spec: [`docs/specs/features/notification-channels/spec.md`](../../../docs/specs/features/notification-channels/spec.md) §6.
