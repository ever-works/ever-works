# @ever-works/discord-channel-plugin

Discord notification channel for the Ever Works platform.

- **Capabilities**: `notification-channel`, `notification-channel-discord`
- **Shape**: `broadcast` (Discord channels = broadcast surfaces)
- **Transport**: incoming webhook URL (v1)
- **Bot-token mode**: planned for a future iteration

## Settings (channel-level `targetConfig`)

| Key | Required | Description |
|-----|----------|-------------|
| `webhookUrl` | Yes | Discord channel incoming webhook URL |
| `username` | No | Override sender username for this channel |
| `avatarUrl` | No | Override sender avatar for this channel |

## Plugin-level settings (tenant default)

| Key | Description |
|-----|-------------|
| `defaultUsername` | Fallback username when channel config doesn't override |
| `defaultAvatarUrl` | Fallback avatar when channel config doesn't override |

Refs spec: [`docs/specs/features/notification-channels/spec.md`](../../../docs/specs/features/notification-channels/spec.md) §6.
