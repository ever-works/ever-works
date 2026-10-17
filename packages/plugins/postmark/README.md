# @ever-works/postmark-plugin

Postmark email provider for the Ever Works platform.

- **Capabilities**: `email-outbound`, `email-inbound`
- **Outbound**: POST `/email` on Postmark Server API
- **Inbound**: Postmark Inbound Streams webhook parser
- **Delivery events**: `Delivery`, `Bounce`, `SpamComplaint`, `Open`, `Click`

## Settings

| Key                    | Required | Description                                        |
| ---------------------- | -------- | -------------------------------------------------- |
| `apiKey`               | Yes      | Postmark Server API token                          |
| `defaultSenderDomain`  | No       | Default `From` domain                              |
| `inboundWebhookSecret` | Inbound  | Basic-Auth secret for inbound webhook verification |
| `inboundStreamId`      | No       | Specific inbound stream id                         |

Env-var fallbacks: `POSTMARK_API_KEY`, `POSTMARK_INBOUND_SECRET`.

**Webhooks need a secret.** With no `inboundWebhookSecret` / `POSTMARK_INBOUND_SECRET` at the resolved scope, inbound
and delivery-event webhooks are refused (`401`). Postmark authenticates both with HTTP Basic auth, username `postmark`
and the secret as password:

- **Inbound** (server → Settings → Inbound webhook URL): embed the credential in the URL,
  `https://postmark:<secret>@<your-domain>/api/email/inbound/postmark`.
- **Delivery events** (server → Webhooks → Add webhook → Basic auth credentials): username `postmark`, password
  `<secret>`, URL `https://<your-domain>/api/email/events/postmark`. Delivery events are verified with the
  admin/env-scope secret (an event names no recipient, so no per-user secret applies).

A local stack with no public webhook URL may opt out with `EMAIL_INBOUND_ALLOW_UNSIGNED=true` (that exact string).

## Webhook URLs

Register at Postmark dashboard:

- Inbound: `https://<your-domain>/api/email/inbound/postmark`
- Delivery events: `https://<your-domain>/api/email/events/postmark`

Refs spec: [`docs/specs/features/email-providers/spec.md`](../../../docs/specs/features/email-providers/spec.md) §6.
