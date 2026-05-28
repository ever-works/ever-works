# @ever-works/resend-plugin

Resend email provider for the Ever Works platform (outbound only).

- **Capabilities**: `email-outbound`
- **Outbound**: official `resend` SDK (`resend.emails.send`) with native idempotency keys
- **Inbound**: not yet supported — Resend inbound is in private beta. Will be added when GA.

## Settings

| Key                   | Required | Description           |
| --------------------- | -------- | --------------------- |
| `apiKey`              | Yes      | Resend API key        |
| `defaultSenderDomain` | No       | Default `from` domain |

Env-var fallback: `RESEND_API_KEY`.

Refs spec: [`docs/specs/features/email-providers/spec.md`](../../../docs/specs/features/email-providers/spec.md) §6.
