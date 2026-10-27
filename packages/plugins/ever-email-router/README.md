# @ever-works/ever-email-router-plugin

Ever Email Router plugin for Ever Works — receive mail for `@ever.email` addresses from the shared Cloudflare Worker **ever-email-router**.

- **Category**: `email-provider`
- **Capabilities**: `email-inbound` (it sends nothing — pair it with an outbound provider to reply)
- **Webhook**: `POST /api/email/inbound/ever-email-router`, answered with counts (`inboundAck: 'counts'`)

## Settings

| Key                    | Secret | Admin-only | Env var                    | Required |
| ---------------------- | ------ | ---------- | -------------------------- | -------- |
| `inboundWebhookSecret` | yes    | yes        | `EVER_EMAIL_ROUTER_SECRET` | yes      |

The API also reads `EVER_EMAIL_DOMAIN` (default `ever.email`): the only domain an address registered with this plugin may use.

## Contract

The router posts one request **per recipient**:

```
POST /api/email/inbound/ever-email-router
content-type: application/json
x-ever-email-signature: t=<unix seconds>,v1=<lowercase hex HMAC-SHA256(secret, "<t>.<exact raw request body>")>

{
  "raw": "<base64 RFC 5322 message>",
  "envelope": { "from": "<envelope sender>", "to": ["<one recipient>"] },
  "authenticationResults": "<optional: Cloudflare's own Authentication-Results value>"
}
```

Answers:

| Status                | Body                                                       | Router reads it as                                            |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `202`                 | `{"accepted":1,"duplicates":0,"dropped":0}`                | taken — delivered to the address's Agent                      |
| `202`                 | `{"accepted":0,"duplicates":1,"dropped":0}`                | taken — already delivered (a retry)                           |
| `202`                 | `{"accepted":0,"duplicates":0,"dropped":1}`                | not ours — no such address here (or none takes it)            |
| `401`                 | `{"statusCode":401,"message":"Invalid webhook signature"}` | temporary (bad/missing signature, stale timestamp, no secret) |
| `413`                 | —                                                          | too large (`INBOUND_EMAIL_BODY_LIMIT`, default 25 MB)         |
| `404` / `429` / `5xx` | —                                                          | temporary — retry later (the plugin not enabled here: `500`)  |

`dropped` covers every delivery nothing took: no enabled inbound address registered with this plugin, an address with no inbound Agent assignment, or a disabled one.

## Security

- **Signature first.** `verifyWebhookSignature` recomputes `HMAC-SHA256(secret, "<t>." + raw body)` over the exact bytes received and compares it in constant time (`crypto.timingSafeEqual`). It refuses a missing or malformed header, a timestamp more than **300 s** from the API's clock (either way), and a mismatch. Several `v1=` values are accepted (one per secret during a rotation).
- **Fails closed.** No secret, or one shorter than **24 characters**, refuses every delivery. There is no unsigned opt-out (`EMAIL_INBOUND_ALLOW_UNSIGNED` does not apply).
- **The deployment's secret only.** The setting is `x-adminOnly`, so a tenant can never save their own secret; an unknown recipient is verified with the admin/env secret before anything is answered.
- **Counts only after verification.** The platform's other inbound webhooks answer `{"received":true}` whatever happened (EW-718: no routing leak). The counts are answered only once the signature passed — the caller has proven it holds the deployment's secret — and carry no id, Agent or mode.
- **Bound to the envelope.** The message is routed to the envelope recipient (inside the signed body), never to the sender-written `To` header.
- **Replays are harmless.** Inside the 300 s window a captured request can only re-deliver the same message to the same recipient, which the `(pluginId, providerMessageId)` unique index answers as a duplicate.
- **One owner per mailbox.** The API refuses (`400`) an address of this plugin outside `EVER_EMAIL_DOMAIN`, and (`409`) a mailbox another account already holds for inbound mail — under any plugin, since the inbound binding picks the oldest such row. Re-enabling a disabled address is checked the same way. Addresses are stored lower-cased.

## Parsing

- The `raw` message is decoded with [`postal-mime`](https://github.com/postalsys/postal-mime): `from` (header `From`, else the envelope sender), `to` / `cc` (bare mailboxes; a Bcc'd delivery's `to` is the envelope recipient), subject, text and HTML bodies, every attachment (base64; the dispatcher's per-message limits apply), `Message-ID`, `In-Reply-To` and `References` for threading.
- `providerMessageId` is `sha256(Message-ID, else the raw message)` + `:` + the recipient, so the same message sent to two Ever Works addresses is two deliveries, not a duplicate (a recipient too long for the 200-character column is replaced by its own sha256).
- `authenticationResults` is mapped onto the metadata the trust module reads — `dmarc`, `spf` / `spfDomain` (from `smtp.mailfrom`), `dkim` / `dkimDomain` (from `header.d`; with several signatures a pass aligned with `From` wins) — and kept as the topmost `Authentication-Results` of `metadata.headers`. The message's own `Authentication-Results` headers are dropped (the sender could have written them). A deployment whose only inbound provider is the router may also set `INBOUND_EMAIL_AUTHSERV_ID=mx.cloudflare.net`.

## Setup

1. Generate a secret (at least 24 characters, e.g. `openssl rand -hex 32`) and give the **same value** to the Worker and to the API as `EVER_EMAIL_ROUTER_SECRET` (the deployment's secret store — never a tenant setting).
2. Point the Worker at `https://<api host>/api/email/inbound/ever-email-router`.
3. In Ever Works, add an address `name@ever.email` with direction **Inbound** and provider **Ever Email Router** (Settings → Email addresses).
4. Assign the address to an Agent (inbound). Mail to it now creates a Task, or joins the Agent's conversation, per the assignment's dispatch mode.
