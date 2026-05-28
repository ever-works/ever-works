# @ever-works/postmark-plugin

Postmark email provider for the Ever Works platform.

- **Capabilities**: `email-outbound`, `email-inbound`
- **Outbound**: POST `/email` on Postmark Server API
- **Inbound**: Postmark Inbound Streams webhook parser
- **Delivery events**: `Delivery`, `Bounce`, `SpamComplaint`, `Open`, `Click`

## Settings

| Key | Required | Description |
|-----|----------|-------------|
| `apiKey` | Yes | Postmark Server API token |
| `defaultSenderDomain` | No | Default `From` domain |
| `inboundWebhookSecret` | No | Basic-Auth secret for inbound webhook verification |
| `inboundStreamId` | No | Specific inbound stream id |

Env-var fallbacks: `POSTMARK_API_KEY`, `POSTMARK_INBOUND_SECRET`.

## Webhook URLs

Register at Postmark dashboard:

- Inbound: `https://<your-domain>/api/email/inbound/postmark`
- Delivery events: `https://<your-domain>/api/email/events/postmark`

Refs spec: [`docs/specs/features/email-providers/spec.md`](../../../docs/specs/features/email-providers/spec.md) §6.
