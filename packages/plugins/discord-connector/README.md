# @ever-works/discord-connector-plugin

First-party **Discord connector** for the Ever Works platform — a bidirectional
communication-channel plugin (the `connector` category). This increment ships the
**outbound** leg; inbound Interactions API routing (verify → pair → route to an
Agent → reply) is a follow-up.

- **Category**: `connector`
- **Capabilities**: `connector`, `connector-discord`
- **Direction**: `outbound` (metadata is inbound-ready; the `publicKey`
  setting is captured now so inbound needs no reconfiguration in P2)
- **Transport**: official `discord.js` SDK (`REST` client →
  `POST /channels/:id/messages`) with a bot token — distinct from
  `discord-channel`'s incoming-webhook `fetch` path. A connector is a superset
  of a channel; both coexist.
- **Rich outbound**: Discord embeds via the `discord-embeds` rich payload kind.

## Connection config (`targetConfig`)

| Key                | Required | Secret | Description                                                       |
| ------------------ | -------- | ------ | --------------------------------------------------------------- |
| `botToken`         | Yes      | Yes    | Bot token. Env fallback `DISCORD_BOT_TOKEN`.                     |
| `publicKey`        | No       | Yes    | Application public key for inbound Interactions API (P2). Env fallback `DISCORD_PUBLIC_KEY`. |
| `applicationId`    | No       | No     | Discord application (client) id.                                 |
| `guildId`          | No       | No     | Default guild/server id.                                         |
| `defaultChannelId` | No       | No     | Default destination channel (e.g. `123456789012345678`).        |
| `channelId`        | No       | No     | Per-send channel override (takes precedence over the default).   |

The `discord.js` `REST` client pins the host to `discord.com` and injects the
`Authorization: Bot <token>` header, so there is no SSRF surface. `send` is
idempotent on `messageRef`, scoped to `connectorId` + channel. `verifyConnection`
calls `GET /users/@me` to validate the bot token.

## Follow-ups

- **Inbound (P2)**: Discord Interactions API — `verifyInbound` (Ed25519 signature
  over `X-Signature-Ed25519` + `X-Signature-Timestamp`), `handleChallenge` for the
  `PING` handshake, `parseInbound` → route to an Agent, `reply` into the channel.
- **Sibling connectors**: `slack-connector` (shipped), then `whatsapp-connector`,
  `notion-connector`, `microsoft-365-connector` (P3).

Refs spec: [`docs/specs/features/connectors/spec.md`](../../../docs/specs/features/connectors/spec.md) §7.5.1.
