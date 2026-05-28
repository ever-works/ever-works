# @ever-works/mailchimp-transactional-plugin

Mailchimp Transactional (formerly **Mandrill**) email provider plugin for Ever Works (Notifications v2, EW-650).

- **Category**: `email-provider`
- **Capabilities**: `email-outbound`
- **API**: Mandrill Messages API (`POST https://mandrillapp.com/api/1.0/messages/send.json`)

> This is the **transactional** product (per-message API), not the Mailchimp Marketing/campaigns API.

## Settings

| Key                   | Secret | Env var            | Required |
| --------------------- | ------ | ------------------ | -------- |
| `apiKey`              | yes    | `MANDRILL_API_KEY` | yes      |
| `defaultSenderDomain` | no     | —                  | no       |

## Notes

- Built on the official **`@mailchimp/mailchimp_transactional`** SDK (`messages.send`). The SDK ships no `.d.ts`, so a minimal local ambient declaration covers the surface used.
- Mandrill returns an array of per-recipient results; the plugin maps `sent`/`queued`/`scheduled` → `accepted` and `rejected`/`invalid` → `rejected` (with reason), and uses the first `_id` as the provider message id. On API errors the SDK resolves with an error envelope (it does not throw) — handled.
- `sendEmail` de-dupes on `EmailSendInput.messageRef` (idempotency) across retries.
