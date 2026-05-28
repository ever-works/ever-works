# @ever-works/sendgrid-plugin

Twilio SendGrid email provider plugin for Ever Works (Notifications v2, EW-650).

- **Category**: `email-provider`
- **Capabilities**: `email-outbound`
- **API**: SendGrid v3 Mail Send (`POST https://api.sendgrid.com/v3/mail/send`)

## Settings

| Key                   | Secret | Env var            | Required |
| --------------------- | ------ | ------------------ | -------- |
| `apiKey`              | yes    | `SENDGRID_API_KEY` | yes      |
| `defaultSenderDomain` | no     | —                  | no       |

## Notes

- Zero runtime deps beyond `@ever-works/plugin` — talks to the REST API via `fetch`.
- Success is `202 Accepted` with an empty body; the provider message id comes from the `X-Message-Id` response header.
- `sendEmail` de-dupes on `EmailSendInput.messageRef` (idempotency) across retries.
- Inbound (SendGrid Inbound Parse) is a separate webhook surface — add an `IEmailInboundPlugin` implementation when needed.
