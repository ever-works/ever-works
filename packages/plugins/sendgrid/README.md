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

- Built on the official **`@sendgrid/mail`** SDK (a fresh `MailService` per send keeps the API key request-scoped / multi-tenant safe).
- The provider message id comes from the `X-Message-Id` response header surfaced by the SDK.
- `sendEmail` de-dupes on `EmailSendInput.messageRef` (idempotency) across retries.
- Inbound (SendGrid Inbound Parse) is a separate webhook surface — add an `IEmailInboundPlugin` implementation when needed.
