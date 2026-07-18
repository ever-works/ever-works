# @ever-works/slack-connector-plugin

First-party **Slack connector** for the Ever Works platform — a bidirectional
communication-channel plugin (the `connector` category). This increment ships the
**outbound** leg; inbound Events API routing (verify → pair → route to an
Agent → reply) is a follow-up.

- **Category**: `connector`
- **Capabilities**: `connector`, `connector-slack`
- **Direction**: `outbound` (metadata is inbound-ready; the `signingSecret`
  setting is captured now so inbound needs no reconfiguration in P2)
- **Transport**: official `@slack/web-api` SDK (`WebClient.chat.postMessage`)
  with a bot token — distinct from `slack-channel`'s incoming-webhook
  `@slack/webhook` path. A connector is a superset of a channel; both coexist.
- **Rich outbound**: Block Kit via the `slack-blocks` rich payload kind.

## Connection config (`targetConfig`)

| Key                | Required | Secret | Description                                                    |
| ------------------ | -------- | ------ | ------------------------------------------------------------- |
| `botToken`         | Yes      | Yes    | Bot User OAuth token (`xoxb-…`). Env fallback `SLACK_BOT_TOKEN`. |
| `signingSecret`    | No       | Yes    | For inbound Events API (P2). Env fallback `SLACK_SIGNING_SECRET`. |
| `appId`            | No       | No     | Slack app id.                                                 |
| `defaultChannelId` | No       | No     | Default destination channel (e.g. `C0123456789`).            |
| `channelId`        | No       | No     | Per-send channel override (takes precedence over the default). |

The `@slack/web-api` `WebClient` pins the host to `slack.com`, so there is no SSRF
surface. `send` is idempotent on `messageRef`, scoped to `connectorId` + channel.
`verifyConnection` calls `auth.test` to validate the bot token.

## Follow-ups

- **Inbound (P2)**: Slack Events API — `verifyInbound` (HMAC-SHA256 over
  `v0:{ts}:{rawBody}` + 5-min skew clamp + constant-time compare), `handleChallenge`
  for `url_verification`, `parseInbound` → route to an Agent, `reply` into the thread.
- **Sibling connectors**: `discord-connector` (P2), then `whatsapp-connector`,
  `notion-connector`, `microsoft-365-connector` (P3).

Refs spec: [`docs/specs/features/connectors/spec.md`](../../../docs/specs/features/connectors/spec.md) §7.5.1.
