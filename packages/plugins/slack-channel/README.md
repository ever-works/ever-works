# @ever-works/slack-channel-plugin

Slack notification channel for the Ever Works platform.

- **Capabilities**: `notification-channel`, `notification-channel-slack`
- **Shape**: `broadcast`
- **Transport**: official `@slack/webhook` SDK (`IncomingWebhook`) over a Slack incoming webhook (Block Kit supported via the `slack-blocks` rich payload kind)

## Settings (channel-level `targetConfig`)

| Key          | Required | Description                                                |
| ------------ | -------- | ---------------------------------------------------------- |
| `webhookUrl` | Yes      | Slack incoming webhook URL (`https://hooks.slack.com/...`) |
| `username`   | No       | Override sender username for this channel                  |
| `iconEmoji`  | No       | Override sender icon emoji for this channel                |

## Plugin-level settings (tenant default)

| Key                | Description                               |
| ------------------ | ----------------------------------------- |
| `defaultUsername`  | Fallback username                         |
| `defaultIconEmoji` | Fallback icon emoji (e.g. `:robot_face:`) |

Slack incoming webhooks return the literal `ok` on success (no message id), so `providerMessageId` is synthesized from the idempotency key.

Refs spec: [`docs/specs/features/notification-channels/spec.md`](../../../docs/specs/features/notification-channels/spec.md) §6.
