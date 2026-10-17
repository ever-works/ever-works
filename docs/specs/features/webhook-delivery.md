# Webhook delivery — outbound HTTPS signed POSTs

> **Ticket:** [EW-634 — Webhook delivery worker — sign + POST + retry-with-backoff](https://evertech.atlassian.net/browse/EW-634)
>
> **Subscriptions API:** [`/api/webhooks`](../../../apps/api/src/webhooks/webhooks.controller.ts) (shipped earlier in commit `60741b9d`)
>
> **Delivery worker:** [`packages/tasks/src/tasks/trigger/webhook-delivery.task.ts`](../../../packages/tasks/src/tasks/trigger/webhook-delivery.task.ts)

This doc is the **receiver-side contract**: what an Ever Works webhook
receiver will see on the wire, how to verify the signature, and the
retry behaviour to expect from the platform.

For the producer-side service implementation (in-process orchestrator,
Trigger.dev wrapping, dead-letter logic), read the source above.

---

## Request shape

Every outbound delivery is a single `POST` with a JSON body. The body is
the exact bytes that were signed — receivers MUST verify the signature
against the **raw** body, not a re-serialized parse.

```
POST <your-registered-url>
Host: <your-host>
Content-Type: application/json; charset=utf-8
Content-Length: <up to 1,048,576>
X-Ever-Works-Event: <event-name>
X-Ever-Works-Delivery: <uuidv4>
X-Ever-Works-Signature-256: sha256=<hex>
X-Hub-Signature-256: sha256=<hex>      # alias of the line above
```

The two signature headers carry the **same** value. `X-Ever-Works-Signature-256`
is the canonical, brand-owned header name; `X-Hub-Signature-256` is a
GitHub-style alias kept because some early receivers were wired against
it. Verify whichever you prefer — they're computed identically.

**Per-delivery constraints:**

| Constraint          | Value                                   | Why                                                                                                                   |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Maximum body size   | 1 MiB                                   | Refusing oversized payloads at the producer side; receivers don't need an unbounded buffer                            |
| Per-attempt timeout | 10 s                                    | Slow receivers force the platform to choose between holding open connections and serving other deliveries             |
| Redirects           | not followed                            | The URL you registered is the URL we POST to. A 3xx response is treated as `redirect_refused` and counts as a failure |
| Allowed schemes     | `https://` (`http://` in dev/test only) | Production rejects loopback / private / link-local / metadata IPs at SSRF guard time                                  |

---

## Retry schedule

Failed deliveries retry with **exponential backoff** managed by
Trigger.dev. Roughly:

```
attempt 1   →  immediate
attempt 2   →  ~30 s later
attempt 3   →  ~3 min later
attempt 4   →  ~18 min later
attempt 5   →  ~1.8 h later
attempt 6   →  ~11 h later
attempts 7+ →  capped at 24 h
```

The exact spacing has jitter (so a fleet of receivers coming back
simultaneously doesn't thundering-herd the platform).

**What counts as a retryable failure:**

| Outcome on the wire                     | Retried?                     | Counter behaviour                   |
| --------------------------------------- | ---------------------------- | ----------------------------------- |
| 2xx                                     | no — `delivered`             | counter resets                      |
| 3xx (any redirect)                      | **no** — `redirect_refused`  | counter bumps; not retried          |
| 4xx                                     | **no** — `client_error`      | counter bumps; not retried          |
| 5xx                                     | yes — `server_error`         | counter bumps; retried with backoff |
| Network error / DNS / SSRF post-resolve | yes — `server_error`         | counter bumps; retried with backoff |
| Timeout (10s elapsed)                   | yes — `timeout`              | counter bumps; retried with backoff |
| Body > 1 MiB                            | **no** — `payload_too_large` | counter bumps; not retried          |

**Dead-letter:** after `WEBHOOK_MAX_CONSECUTIVE_FAILURES` consecutive
failures (default `10`), the subscription transitions to
`status='failed'` and stops being delivered. The customer must
recreate the subscription (or rotate its secret and reconfigure their
receiver) to resume deliveries.

---

## Verifying the signature

The signature is `HMAC-SHA256(rawSecret, rawBody)` returned as
`sha256=<lowercase-hex>`. Receivers MUST verify against the **raw**
request bytes, not a parsed-and-reserialized JSON value (whitespace,
key order, and unicode escaping all matter).

Use a **constant-time** comparison — a naive `===` check leaks one bit
of the expected signature per request and is the canonical "how the
attacker pivots" failure mode.

### Node.js (>= 18)

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;

function verify(rawBody: Buffer, headerValue: string | undefined): boolean {
	if (!headerValue) return false;
	const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
	const a = Buffer.from(headerValue);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on('data', (c) => chunks.push(c as Buffer));
	req.on('end', () => {
		const raw = Buffer.concat(chunks);
		const sig =
			(req.headers['x-ever-works-signature-256'] as string | undefined) ??
			(req.headers['x-hub-signature-256'] as string | undefined);
		if (!verify(raw, sig)) {
			res.writeHead(401).end();
			return;
		}
		const event = req.headers['x-ever-works-event'];
		const delivery = req.headers['x-ever-works-delivery'];
		// … hand `raw.toString('utf8')` to your business logic …
		res.writeHead(200).end();
		console.log(`accepted ${event} delivery=${delivery}`);
	});
}).listen(3000);
```

### Bun

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;

Bun.serve({
	port: 3000,
	async fetch(req) {
		const raw = Buffer.from(await req.arrayBuffer());
		const headerSig = req.headers.get('x-ever-works-signature-256') ?? req.headers.get('x-hub-signature-256');
		if (!headerSig) return new Response('missing signature', { status: 401 });
		const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
		const a = Buffer.from(headerSig);
		const b = Buffer.from(expected);
		if (a.length !== b.length || !timingSafeEqual(a, b)) {
			return new Response('bad signature', { status: 401 });
		}
		// … hand `raw.toString('utf8')` to your business logic …
		return new Response('ok');
	}
});
```

### Deno

```ts
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET')!;

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, body);
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

Deno.serve({ port: 3000 }, async (req) => {
	const raw = new Uint8Array(await req.arrayBuffer());
	const sig = req.headers.get('x-ever-works-signature-256') ?? req.headers.get('x-hub-signature-256');
	if (!sig) return new Response('missing signature', { status: 401 });

	const expected = 'sha256=' + (await hmacSha256Hex(WEBHOOK_SECRET, raw));
	const a = new TextEncoder().encode(sig);
	const b = new TextEncoder().encode(expected);
	if (!timingSafeEqual(a, b)) {
		return new Response('bad signature', { status: 401 });
	}
	// … hand `new TextDecoder().decode(raw)` to your business logic …
	return new Response('ok');
});
```

---

## Testing your receiver

Two ways to confirm a freshly-registered subscription works **before**
plugging it into a CI pipeline:

1. **Synchronous test-fire endpoint:**

    ```bash
    curl -X POST -H "Authorization: Bearer $TOKEN" \
      https://apps.ever.works/api/webhooks/<subscription-id>/test
    ```

    Returns the delivery outcome inline (the same `outcome` /
    `status` shape persisted in the deliveries log). Useful for
    "press the button, see green or see why not" verification.

2. **List recent deliveries:**

    ```bash
    curl -H "Authorization: Bearer $TOKEN" \
      https://apps.ever.works/api/webhooks/deliveries
    ```

    Returns the last 50 delivery attempts across all of your active
    subscriptions, most-recent first, including the wire-level outcome
    bucket (`success`, `client_error`, `server_error`, `timeout`,
    `redirect_refused`, `payload_too_large`, `ssrf_blocked`).

3. **Re-enqueue a delivery:**

    ```bash
    curl -X POST -H "Authorization: Bearer $TOKEN" \
      https://apps.ever.works/api/webhooks/deliveries/<delivery-id>/redeliver
    ```

    Reuses the originally-signed payload (NOT a freshly-emitted event)
    so the receiver sees exactly what it would have seen the first time.

---

## Webhooks v2 — domain events (EW-P1-5)

> **Contract:** integration contract v1, B.5 —
> [`integrations-api-v1/spec.md` §5](./integrations-api-v1/spec.md),
> [signature test vectors](./integrations-api-v1/contract/webhook-signature-vectors.json).
> **Fan-out:** [`webhook-domain-event-fanout.service.ts`](../../../packages/agent/src/services/webhook-domain-event-fanout.service.ts).

A **v2 subscription** (`version: 2`) receives [domain events](./domain-events/spec.md)
instead of the five legacy work/deployment events. It is created with
`events` + `organizationIds`:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  https://apps.ever.works/api/webhooks \
  -d '{"url":"https://example.com/ever","events":["task.*","team.member.added"],
       "organizationIds":["<org-id>"],"excludeOriginTags":["gauzy:<connection-id>"]}'
```

### What a v2 subscription receives

- One event per POST. The body is the event envelope (`id`, `seq`, `type`,
  `aggregate`, `actor`, `origin`, `changedFields`, `data`, `previous`, …),
  exactly as `GET /api/integrations/v1/events` serves it.
- Only events of its `organizationIds`. Never personal-scope events, and
  never events of `private` aggregates, except the id-only
  `*.visibility_changed` notice.
- Only types matching `events`: catalog types, `<prefix>.*` or `*`.
  `task.runtime_updated` arrives only when named exactly.
- Never events whose `origin.tag` is listed in `excludeOriginTags`. This is
  the loop guard for two-way sync.
- Only events after the subscription was created: it records the change-feed
  head at creation (`startAfterSeq`) and receives later positions only. It also
  receives them only while its owner still has access, checked when the
  delivery is created AND again right before every send or retry:
    - a user owner must still belong to the organization's tenant;
    - an integration-key owner must be active, unexpired and still pinned to
      the organization.

    When the owner is gone or the key is revoked, the subscription becomes
    `disabled`, and `PATCH` can neither pause nor resume it.

Delivery is **at least once** and **unordered**. Dedupe on the envelope
`id`, order by `seq` per aggregate, and fill gaps from
`GET /api/integrations/v1/events`. The fan-out reads the change feed from
its own cursor (`plugin_event_cursors`, `core:webhooks-v2`), and a unique
`(subscriptionId, eventId)` index keeps it to one delivery per event. A
delivery that was created but never enqueued (the API stopped in between) is
re-enqueued after 5 minutes.
Retries follow the ladder above; only 5xx and timeouts are retried.

### Headers and signature

| Header                   | Value                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| `X-Ever-Works-Event`     | the event type, e.g. `task.updated`                              |
| `X-Ever-Works-Event-Id`  | the envelope `id` (`evt_<ULID>`)                                 |
| `X-Ever-Works-Delivery`  | the delivery id (uuid); a redelivery gets a new one              |
| `X-Ever-Works-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>` |

- The HMAC key is the secret string exactly as returned, as UTF-8 bytes.
- Reject `|now - t| > 300` (inclusive window).
- Accept when **any** `v1=` matches, compared in constant time.
- After `POST /api/webhooks/:id/rotate-secret`, the previous secret keeps
  signing as a second `v1=` for `WEBHOOK_SECRET_ROTATION_GRACE_HOURS`
  (default 24 h).
- v2 deliveries carry **no** `X-Ever-Works-Signature-256` /
  `X-Hub-Signature-256`.
- The scheme is the same as Gauzy's `verifyWebhookSignature`. The reference
  verifier is `verifyWebhookV2Signature` in
  [`webhook-signature-v2.ts`](../../../packages/agent/src/services/webhook-signature-v2.ts).
  The published vectors are its test.

### Managing subscriptions

- `GET /api/webhooks` lists every subscription, whatever its status
  (`active`, `paused`, `failed`, `disabled`).
- `PATCH /api/webhooks/:id`:
    - `{"status":"paused"}` pauses any subscription;
    - `{"status":"active"}` resumes a paused or failed one and resets its
      failure streak (within the 25-active-subscriptions limit);
    - a v2 subscription also takes `url`, `events`, `organizationIds`,
      `excludeOriginTags` and `description`.
- `GET /api/webhooks/deliveries?subscriptionId=<id>&limit=<n>` shows one
  subscription's deliveries; `POST /api/webhooks/deliveries/:id/redeliver`
  re-sends one.
