# @ever-works/mailgun-plugin

Mailgun email provider plugin for Ever Works (Notifications v2, EW-650).

- **Category**: `email-provider`
- **Capabilities**: `email-outbound`, `email-inbound`
- **API**: Mailgun Messages API (form-encoded) + signed inbound routes; US (`api.mailgun.net`) and EU (`api.eu.mailgun.net`) regions.

## Settings

| Key                 | Secret | Env var                       | Required |
| ------------------- | ------ | ----------------------------- | -------- |
| `apiKey`            | yes    | `MAILGUN_API_KEY`             | yes      |
| `domain`            | no     | `MAILGUN_DOMAIN`              | yes      |
| `region`            | no     | `MAILGUN_REGION` (`us`/`eu`)  | no (us)  |
| `webhookSigningKey` | yes    | `MAILGUN_WEBHOOK_SIGNING_KEY` | no       |

## Notes

- Outbound is built on the official **`mailgun.js`** SDK (`messages.create`); metadata is forwarded as Mailgun `v:` custom variables.
- Inbound HMAC verification uses Node `crypto` — Mailgun ships no SDK helper for inbound-route signature checking.
- Inbound verifies the Mailgun **HMAC-SHA256** signature — `HMAC(signingKey, timestamp + token)` compared in constant time — and decodes both JSON and form-urlencoded webhook shapes. When no signing key is set, verification is skipped (operator opt-in).
- `parseInboundWebhook` maps Mailgun's parsed fields (`sender`/`recipient`/`subject`/`body-plain`/`body-html`). Multipart attachment extraction requires a multipart parser at the controller layer and is left empty here.
