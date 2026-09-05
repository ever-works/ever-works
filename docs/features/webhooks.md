---
id: webhooks
title: Outbound Webhooks
sidebar_label: Webhooks
description: Register HTTPS endpoints that receive signed POSTs when your Works are created, generated or deployed — subscriptions, HMAC signature verification, retries with backoff, and the deliveries log.
---

# Outbound Webhooks

An **outbound webhook** is a URL of yours that Ever Works calls when something happens inside the platform. You register the endpoint once, the platform hands you a signing secret, and from then on every matching event arrives as a signed `POST` with a JSON body — a Work finished generating, a deployment went live, a deployment failed.

This is the mirror image of [Inbound Triggers](/features/inbound-triggers). A trigger is _the outside world calling the platform_; a webhook subscription is _the platform calling the outside world_.

:::note This surface is API-only today
There is no Webhooks screen in the dashboard and no `ever-works webhooks` CLI command. Subscriptions are created, listed, paused, rotated and deleted over REST at `/api/webhooks`, and the delivery log is read the same way. Everything below is written against that API.
:::

:::info Not the same thing as the internal event bus
[Event & Notification System](/advanced/webhook-system) documents the **internal** NestJS `EventEmitter2` bus that platform services and plugins subscribe to in-process. That page is for plugin authors. This page is the **external, over-the-wire** surface — HTTPS calls that leave the platform and land on your server.
:::

## The API at a glance

Every route is authenticated. Send either your dashboard session cookie or an [API key](/features/api-keys) as `x-api-key: ew_live_…` (or `Authorization: Bearer ew_live_…`). Anything belonging to another account answers **404**, never 403 — the API refuses to confirm that an id it does not own exists.

| Route                                            | Method   | What it does                                                                | Rate limit |
| ------------------------------------------------ | -------- | --------------------------------------------------------------------------- | ---------- |
| `/api/webhooks`                                  | `GET`    | List your **active** subscriptions. No secret material is ever returned.    | global     |
| `/api/webhooks`                                  | `POST`   | Create a subscription. Returns the raw `signingSecret` **once**.            | 10 / min   |
| `/api/webhooks/:id`                              | `PATCH`  | Pause a subscription (`{"status":"paused"}`).                               | 20 / min   |
| `/api/webhooks/:id`                              | `DELETE` | Delete a subscription. Irreversible; answers `204`.                         | global     |
| `/api/webhooks/:id/test`                         | `POST`   | Fire a synthetic `webhook.test` delivery now and return the outcome inline. | 5 / min    |
| `/api/webhooks/:id/rotate-secret`                | `POST`   | Mint a new signing secret. The old one is irretrievable afterwards.         | 5 / min    |
| `/api/webhooks/deliveries`                       | `GET`    | The 50 most recent deliveries across all your subscriptions, newest first.  | global     |
| `/api/webhooks/deliveries/:deliveryId/redeliver` | `POST`   | Re-enqueue one past delivery, reusing its original payload. Answers `202`.  | 10 / min   |

## Which events fire

A subscription is either **account-scoped** (no `workId`) or **Work-scoped** (`workId` set — the caller must be allowed to view that Work, or the create call answers 404). Account-scoped subscriptions receive the events of every Work you own; Work-scoped subscriptions receive only that Work's.

| Event                       | Fires when                              | Extra payload fields                                             |
| --------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `work.created`              | A Work is created                       | `workId`, `workName`                                             |
| `work.generation.completed` | A generation run finishes               | `workId`, `workName`, `itemsCount`, `generateStatus`             |
| `deployment.dispatched`     | A deployment is handed to its provider  | `workId`, `providerId`, `providerName`                           |
| `deployment.completed`      | A deployment succeeds                   | `workId`, `providerId`, `providerName`, `url`                    |
| `deployment.failed`         | A deployment reaches a terminal failure | `workId`, `providerId`, `providerName`, `terminalState`, `error` |
| `webhook.test`              | You call `POST /api/webhooks/:id/test`  | `note`                                                           |

That is the whole catalog today. There is no per-subscription event filter — a subscription receives every event in its scope.

## What arrives on the wire

Every delivery is a single `POST` whose body is JSON. The envelope always carries `event`, `sentAt` (ISO-8601) and `accountId`, plus the extra fields from the table above:

```json
{
	"event": "deployment.completed",
	"sentAt": "2026-09-04T09:12:44.108Z",
	"accountId": "9f1c…",
	"workId": "3a7e…",
	"providerId": "vercel",
	"providerName": "Vercel",
	"url": "https://my-directory.example.com"
}
```

Four headers ride with it:

| Header                       | Value                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- |
| `X-Ever-Works-Event`         | The event name, e.g. `deployment.completed`                                 |
| `X-Ever-Works-Delivery`      | The delivery id — the same id the deliveries log shows                      |
| `X-Ever-Works-Signature-256` | `sha256=<hex>` — HMAC-SHA256 of the raw body under your signing secret      |
| `X-Hub-Signature-256`        | A GitHub-style alias carrying the **same** value, for receivers wired to it |

## How to register a webhook

1. **Create the subscription.** `workId` is optional — omit it to receive events for every Work you own.

    ```bash
    curl -X POST http://localhost:3100/api/webhooks \
      -H "Authorization: Bearer <jwt-token>" \
      -H "Content-Type: application/json" \
      -d '{"url": "https://hooks.example.com/ever-works"}'
    ```

2. **Store the `signingSecret` from the response immediately.** It is returned only in that one response body and is never readable again — the platform keeps only an AES-256-GCM envelope of it. Lose it and your only route back is `rotate-secret`.

3. **Verify the signature on your side** before trusting a body (see below).

4. **Test-fire it** and read the outcome inline, before anything real depends on it:

    ```bash
    curl -X POST http://localhost:3100/api/webhooks/<subscription-id>/test \
      -H "Authorization: Bearer <jwt-token>"
    ```

    The response reports `outcome`, the HTTP `status` your endpoint returned, and `ok`. The attempt is also recorded in the deliveries log.

5. **Watch the deliveries log** as real events start flowing:

    ```bash
    curl http://localhost:3100/api/webhooks/deliveries \
      -H "Authorization: Bearer <jwt-token>"
    ```

## Verifying the signature

The signature is `HMAC-SHA256(signingSecret, rawBody)`, hex-encoded and prefixed with `sha256=`. Two rules matter:

- Verify against the **raw request bytes**, not a parsed-and-re-serialized object. Whitespace, key order and unicode escaping all change the hash.
- Compare in **constant time**. A plain `===` leaks the expected signature one byte at a time.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: Buffer, header: string | undefined, secret: string): boolean {
	if (!header) return false;
	const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
	const a = Buffer.from(header);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
```

Worked receivers for Node.js, Bun and Deno live in the receiver-side contract, the [webhook delivery spec](/specs/features/webhook-delivery).

## Retries, backoff and dead-lettering

A delivery is attempted, classified, and retried only when retrying could plausibly work:

| What your endpoint did                        | Outcome             | Retried?                                    |
| --------------------------------------------- | ------------------- | ------------------------------------------- |
| Answered `2xx`                                | `success`           | No — the failure counter resets             |
| Answered `3xx`                                | `redirect_refused`  | **No** — redirects are never followed       |
| Answered `4xx`                                | `client_error`      | **No** — the request was wrong, not unlucky |
| Answered `5xx`, or the connection failed      | `server_error`      | Yes                                         |
| Took longer than 10 s                         | `timeout`           | Yes                                         |
| Body would exceed 1 MiB                       | `payload_too_large` | **No** — refused before it is signed        |
| URL resolved to a private or internal address | `ssrf_blocked`      | **No** — that URL can never be safe         |

Retries use exponential backoff with jitter, starting around 30 s and capping at 24 h, for up to `WEBHOOK_MAX_CONSECUTIVE_FAILURES` attempts (default `10`).

:::warning A dead-lettered subscription does not resume by itself
After that many **consecutive** failures the subscription flips to `status: failed` and stops receiving deliveries. Because `GET /api/webhooks` lists only `active` rows, a dead-lettered subscription also disappears from the listing. Fix your endpoint, then create a fresh subscription — there is no un-fail endpoint.
:::

## Pausing, rotating and deleting

- **Pause** — `PATCH /api/webhooks/:id` with `{"status":"paused"}`. Deliveries stop.
- **Resume is not implemented.** `PATCH` with `{"status":"active"}` deliberately answers **400** rather than silently doing nothing. To start receiving again, create a new subscription.
- **Rotate the secret** — `POST /api/webhooks/:id/rotate-secret` returns a new raw secret once and invalidates the old one immediately. Deploy the new secret to your receiver in the same change window.
- **Delete** — `DELETE /api/webhooks/:id`, answering `204`. There is no undo.
- **Changing the URL is not an edit.** `PATCH` only moves `status`; a new destination means a new subscription, so whoever owns the old endpoint gets a clear signal (deliveries stop) instead of a silent redirect.

## Limits and guardrails

| Guardrail            | Value                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active subscriptions | **25** per account; the 26th `POST` answers 400                                                                                                                 |
| Scheme               | `https://` required outside local dev and test, so a signed body never crosses plaintext                                                                        |
| SSRF                 | Loopback, private, link-local, CGNAT and cloud-metadata targets are refused at create time, again at redeliver, and again at delivery                           |
| Redirects            | Never followed — the URL you registered is the URL that is called                                                                                               |
| Body size            | 1 MiB, enforced before signing                                                                                                                                  |
| Per-attempt timeout  | 10 s                                                                                                                                                            |
| Secret at rest       | AES-256-GCM under `PLATFORM_ENCRYPTION_KEY`. Without that key set, a non-local instance **refuses** to mint a signing secret rather than store one in cleartext |
| Delivery log page    | 50 most recent rows, newest first. There are no filter or paging query parameters yet                                                                           |

## Replaying a delivery

Every attempt is recorded with its `event`, `status`, `attempts`, `lastResponseStatus`, `lastOutcome`, `lastError`, `durationMs` and — when the delivery ran on Trigger.dev — its `triggerRunId`. To replay one:

```bash
curl -X POST http://localhost:3100/api/webhooks/deliveries/<delivery-id>/redeliver \
  -H "Authorization: Bearer <jwt-token>"
```

The replay reuses the **original** payload, so your receiver sees exactly what it would have seen the first time. It is recorded as a new delivery row, and the response carries the new `deliveryId` plus the `runId` when one exists.

## Related

- [Inbound Triggers](/features/inbound-triggers) — the other direction: a signed call from outside spawns a Task
- [Notifications](/features/notifications) — the human-facing delivery surface (bell, Slack, Discord, Telegram, WhatsApp)
- [Digests](/features/digests) — scheduled briefings built on the same notification stack
- [API Keys](/features/api-keys) — the `ew_live_…` credential these routes accept
- [Activity](/features/activity) — the in-platform log of the same events
- [Event & Notification System](/advanced/webhook-system) — the internal `EventEmitter2` bus these outbound deliveries are fanned out from
- [Webhook delivery contract](/specs/features/webhook-delivery) — the full receiver-side spec, with worked Node.js, Bun and Deno receivers
- [Authentication](/api/authentication) — how the API decides who you are
