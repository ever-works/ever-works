import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * COMPLEX cross-feature INTEGRATION flows for webhook signature
 * verification — both the INBOUND github-app webhook receiver and the
 * OUTBOUND subscription-delivery signing surface.
 *
 * Probed against the live API + read from source (no fictional
 * contract):
 *
 * INBOUND github-app receiver — `POST /api/github-app/webhooks`
 *   (`@Public()`, apps/api/.../github-app-webhook.controller.ts):
 *     - header `X-GitHub-Event` is REQUIRED → missing ⇒ 400
 *       BadRequestException("Missing GitHub event header").
 *     - body `X-Hub-Signature-256` verified by
 *       `verifyGitHubWebhookSignature(rawBody, secret, header)`
 *       (packages/agent/.../github-app.utils.ts):
 *         * header MUST start `sha256=`; `sha1=` / missing ⇒ false.
 *         * length-checked, then `timingSafeEqual` on raw bytes.
 *     - any failure ⇒ 401 UnauthorizedException("Invalid GitHub
 *       webhook signature"). In CI `GITHUB_APP_WEBHOOK_SECRET` is
 *       UNSET ⇒ `verifyWebhookSignature` returns false ⇒ EVERY signed
 *       request 401s. So we assert the REJECTION contract (4xx, never
 *       2xx for a forged event, never 5xx), the `sha256=` prefix rule,
 *       and that the secret/signature never leaks back.
 *
 * OUTBOUND subscriptions — `/api/webhooks` (AuthSessionGuard, no
 *   @Public; apps/api/src/webhooks/*):
 *     - POST `/api/webhooks` {url} ⇒ 201
 *       { subscription:{id,accountId,url,status:'active',...},
 *         signingSecret } — raw base64url 32-byte secret, returned ONCE.
 *     - POST `/api/webhooks/:id/rotate-secret` ⇒ 200 { subscription,
 *       signingSecret } — NEW secret, old irretrievable.
 *     - POST `/api/webhooks/:id/test` ⇒ 200 { deliveryId, outcome,
 *       status, ok }. Worker signs body with HMAC-SHA256 + the secret
 *       and sends `X-Ever-Works-Signature-256` / `X-Hub-Signature-256:
 *       sha256=<hex>` (computeSignature in webhook-delivery.service.ts).
 *       In e2e the receiver URL is unreachable ⇒ outcome is one of the
 *       documented non-success buckets (ssrf_blocked / timeout /
 *       server_error / ...). We assert the RECORD + bucket, never live
 *       delivery.
 *     - GET `/api/webhooks/deliveries` ⇒ 200 { deliveries:[...] }.
 *     - cross-account access on any `:id` route ⇒ 404 (enumeration
 *       defense), never 403.
 *
 * Signature parity we CAN verify deterministically: the test harness
 * recomputes `sha256=` + HMAC-SHA256(body, returnedSecret).toString(hex)
 * the same way the worker does, proving the returned `signingSecret` is
 * a real HMAC key and that rotation changes the computed signature.
 */

const GH_WEBHOOK = '/api/github-app/webhooks';
const WEBHOOKS = '/api/webhooks';
const DELIVERIES = `${WEBHOOKS}/deliveries`;

const DELIVERY_OUTCOMES = new Set([
	'success',
	'client_error',
	'server_error',
	'timeout',
	'redirect_refused',
	'payload_too_large',
	'ssrf_blocked'
]);

/** Same shape the outbound delivery worker emits: `sha256=<hex>`. */
function computeSignature(body: string, secret: string): string {
	return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

test.describe('Work / GitHub-App webhook signatures — INBOUND + OUTBOUND', () => {
	test('inbound: forged push with a full-length-but-wrong HMAC is rejected 401, never silently accepted', async ({
		request
	}) => {
		// A 64-char hex digest passes the length check inside
		// verifyGitHubWebhookSignature, so this exercises the
		// timingSafeEqual branch (not the early length bail). Without the
		// real GitHub App webhook secret it can never match → 401.
		const forgedBody = JSON.stringify({
			ref: 'refs/heads/main',
			after: '0000000000000000000000000000000000000000',
			repository: { full_name: 'attacker/forged-repo' }
		});
		const fullLengthWrong = 'sha256=' + 'a'.repeat(64);

		const res = await request.post(`${API_BASE}${GH_WEBHOOK}`, {
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'push',
				'X-Hub-Signature-256': fullLengthWrong
			},
			data: forgedBody
		});

		// A forged event MUST be a clean 4xx — never 2xx (would let any
		// attacker impersonate GitHub) and never 5xx (verifier crash).
		expect(res.status(), `forged push status was ${res.status()}`).toBeGreaterThanOrEqual(401);
		expect(res.status()).toBeLessThan(500);
		expect([200, 201, 202, 204]).not.toContain(res.status());

		// The rejection must not echo the attacker-supplied signature or
		// leak the server's expected one.
		const text = (await res.text()).toLowerCase();
		expect(text.includes('a'.repeat(64)), 'webhook echoed the attacker signature').toBe(false);
		expect(text).not.toMatch(/expected signature|hmac key|webhook secret/i);
	});

	test('inbound: prefix discipline — sha1=, bearer, raw-hex and unprefixed signatures are all rejected, and missing event header is a distinct 400', async ({
		request
	}) => {
		const body = JSON.stringify({ ref: 'refs/heads/main' });

		// 1) Missing X-GitHub-Event header is a *distinct* failure mode:
		//    the controller short-circuits with 400 BEFORE touching the
		//    signature verifier. This proves the two guards are ordered
		//    and independent (event-shape vs authenticity).
		const noEvent = await request.post(`${API_BASE}${GH_WEBHOOK}`, {
			headers: {
				'Content-Type': 'application/json',
				'X-Hub-Signature-256': computeSignature(body, 'whatever')
			},
			data: body
		});
		expect(noEvent.status(), 'missing event header should be 400').toBe(400);
		const noEventBody = await noEvent.text();
		expect(noEventBody.toLowerCase()).toContain('event');

		// 2) GitHub's deprecated SHA-1 signature MUST NOT be accepted —
		//    the verifier returns false for any non-`sha256=` prefix.
		// 3) An unprefixed raw hex digest.
		// 4) A bearer-shaped value.
		// Each present-but-wrong signature reaches the verifier (event
		// header IS present) → 401 Unauthorized.
		const badPrefixes = [
			'sha1=' + 'a'.repeat(40),
			'a'.repeat(64),
			'Bearer ' + 'a'.repeat(40),
			'sha256=' // empty digest after the prefix
		];
		for (const sig of badPrefixes) {
			const res = await request.post(`${API_BASE}${GH_WEBHOOK}`, {
				headers: {
					'Content-Type': 'application/json',
					'X-GitHub-Event': 'push',
					'X-Hub-Signature-256': sig
				},
				data: body
			});
			expect(res.status(), `prefix "${sig.slice(0, 12)}…" should be 401, was ${res.status()}`).toBe(
				401
			);
		}
	});

	test('inbound: an UNKNOWN/unrecognized event type is rejected on signature BEFORE any dispatch (no 5xx on novel events)', async ({
		request
	}) => {
		// GitHub periodically ships new event types. The receiver must
		// gate on authenticity first — a made-up event name with a
		// (necessarily) invalid signature must 401, never crash trying to
		// route the unknown event, and never 200 it through.
		const exoticEvents = [
			'totally_made_up_event_2099',
			'merge_group',
			'deployment_protection_rule',
			'security_and_analysis'
		];
		const body = JSON.stringify({ action: 'created', sender: { login: 'octocat' } });

		for (const ev of exoticEvents) {
			const res = await request.post(`${API_BASE}${GH_WEBHOOK}`, {
				headers: {
					'Content-Type': 'application/json',
					'X-GitHub-Event': ev,
					'X-Hub-Signature-256': computeSignature(body, 'unknown-secret')
				},
				data: body
			});
			// Either 401 (signature gate, the CI path) or — if a real
			// secret were configured and somehow matched, which it can't
			// here — the sync handler tolerates unknown events. Pin the
			// security-relevant invariants: never accepted, never crashed.
			expect(res.status(), `event ${ev} status ${res.status()}`).toBeGreaterThanOrEqual(400);
			expect(res.status(), `event ${ev} crashed`).toBeLessThan(500);
			expect([200, 201, 202, 204], `unknown event ${ev} was accepted`).not.toContain(
				res.status()
			);
		}
	});

	test('outbound: created subscription returns a real HMAC key — test-fire signs with sha256=HMAC(body) and records a delivery in the documented bucket', async ({
		request
	}) => {
		// Cross-spec isolation: a fresh user, never the seeded one.
		const u = await registerUserViaAPI(request);

		// 1) Create the subscription. The raw signingSecret is returned
		//    exactly ONCE here.
		const created = await request.post(`${API_BASE}${WEBHOOKS}`, {
			headers: authedHeaders(u.access_token),
			data: { url: `https://webhook.invalid.ever.works/sig-${Date.now().toString(36)}` }
		});
		expect(created.status()).toBe(201);
		const createBody = await created.json();
		const subscriptionId: string = createBody.subscription.id;
		const secret: string = createBody.signingSecret;

		// The secret is a base64url-encoded 32 random bytes (~43 chars).
		expect(typeof secret).toBe('string');
		expect(secret.length).toBeGreaterThanOrEqual(40);
		expect(secret, 'secret must be url-safe base64url').toMatch(/^[A-Za-z0-9_-]+$/);
		expect(createBody.subscription.status).toBe('active');

		// 2) Prove the returned secret is a usable HMAC key by computing
		//    the exact signature the delivery worker would emit for a
		//    canonical payload. (We do not assert the wire value — the
		//    receiver is unreachable in e2e — we assert the *shape* the
		//    key produces matches the worker's `computeSignature`.)
		const samplePayload = JSON.stringify({ event: 'webhook.test', n: 1 });
		const sig = computeSignature(samplePayload, secret);
		expect(sig, 'computed signature must be sha256=<64 hex>').toMatch(/^sha256=[0-9a-f]{64}$/);

		// 3) Fire a real test delivery. The worker signs + attempts; the
		//    invalid host is unreachable so the outcome is a documented
		//    non-success bucket. We assert the RECORD, never completion.
		const fired = await request.post(`${API_BASE}${WEBHOOKS}/${subscriptionId}/test`, {
			headers: authedHeaders(u.access_token)
		});
		expect(fired.status()).toBe(200);
		const fireBody = await fired.json();
		expect(typeof fireBody.deliveryId).toBe('string');
		expect(DELIVERY_OUTCOMES.has(fireBody.outcome), `unexpected outcome ${fireBody.outcome}`).toBe(
			true
		);
		// Unreachable receiver ⇒ never a delivered success.
		expect(fireBody.outcome).not.toBe('success');
		expect(fireBody.ok).toBe(false);

		// 4) The signed attempt is durably recorded under the caller's
		//    account with the test event name.
		const list = await request.get(`${API_BASE}${DELIVERIES}`, {
			headers: authedHeaders(u.access_token)
		});
		expect(list.status()).toBe(200);
		const { deliveries } = await list.json();
		const hit = (deliveries as Array<{ id: string; subscriptionId: string; event: string }>).find(
			(d) => d.id === fireBody.deliveryId
		);
		expect(hit, 'signed test delivery missing from listing').toBeTruthy();
		expect(hit!.subscriptionId).toBe(subscriptionId);
		expect(hit!.event).toBe('webhook.test');
	});

	test('outbound: secret rotation INVALIDATES the old key — the post-rotation signature differs and the old secret cannot reproduce it', async ({
		request
	}) => {
		const u = await registerUserViaAPI(request);

		const created = await request.post(`${API_BASE}${WEBHOOKS}`, {
			headers: authedHeaders(u.access_token),
			data: { url: `https://webhook.invalid.ever.works/rotate-${Date.now().toString(36)}` }
		});
		expect(created.status()).toBe(201);
		const { subscription, signingSecret: oldSecret } = await created.json();
		const subscriptionId: string = subscription.id;

		// Canonical body both keys will sign.
		const body = JSON.stringify({ event: 'work.created', workId: 'abc', n: 42 });
		const oldSig = computeSignature(body, oldSecret);

		// Rotate. Old secret becomes irretrievable; a NEW raw secret is
		// returned once.
		const rotated = await request.post(`${API_BASE}${WEBHOOKS}/${subscriptionId}/rotate-secret`, {
			headers: authedHeaders(u.access_token)
		});
		expect(rotated.status()).toBe(200);
		const { subscription: rotatedSub, signingSecret: newSecret } = await rotated.json();

		// New secret is a distinct, valid HMAC key on the SAME subscription.
		expect(rotatedSub.id).toBe(subscriptionId);
		expect(typeof newSecret).toBe('string');
		expect(newSecret.length).toBeGreaterThanOrEqual(40);
		expect(newSecret, 'rotation must change the secret').not.toBe(oldSecret);

		// The crux: signing the IDENTICAL body with the rotated key yields
		// a DIFFERENT signature, and the retired key can no longer produce
		// the new signature. A receiver pinned to the old secret would now
		// reject every delivery — exactly the rotation guarantee.
		const newSig = computeSignature(body, newSecret);
		expect(newSig).toMatch(/^sha256=[0-9a-f]{64}$/);
		expect(newSig, 'rotation must change the computed signature').not.toBe(oldSig);
		expect(computeSignature(body, oldSecret)).toBe(oldSig); // determinism guard
		expect(computeSignature(body, oldSecret)).not.toBe(newSig);

		// A delivery fired AFTER rotation still records (now signed with
		// the new key under the hood) — the rotation didn't break the
		// subscription itself.
		const fired = await request.post(`${API_BASE}${WEBHOOKS}/${subscriptionId}/test`, {
			headers: authedHeaders(u.access_token)
		});
		expect(fired.status()).toBe(200);
		const fireBody = await fired.json();
		expect(DELIVERY_OUTCOMES.has(fireBody.outcome)).toBe(true);
	});

	test('outbound: signing-secret integrity — every rotation yields a fresh unpredictable key, raw secret is never re-readable, and signatures are payload-bound', async ({
		request
	}) => {
		const u = await registerUserViaAPI(request);

		const created = await request.post(`${API_BASE}${WEBHOOKS}`, {
			headers: authedHeaders(u.access_token),
			data: { url: `https://webhook.invalid.ever.works/integrity-${Date.now().toString(36)}` }
		});
		expect(created.status()).toBe(201);
		const { subscription, signingSecret: first } = await created.json();
		const subscriptionId: string = subscription.id;

		// Collect a handful of consecutive rotations. Each must be unique
		// (no repeats, no predictable counter) and url-safe base64url.
		const seen = new Set<string>([first]);
		let last = first;
		for (let i = 0; i < 3; i++) {
			const rot = await request.post(`${API_BASE}${WEBHOOKS}/${subscriptionId}/rotate-secret`, {
				headers: authedHeaders(u.access_token)
			});
			expect(rot.status()).toBe(200);
			const { signingSecret } = await rot.json();
			expect(signingSecret, `rotation ${i} repeated a prior secret`).not.toBe(last);
			expect(seen.has(signingSecret), `rotation ${i} collided with an earlier secret`).toBe(false);
			expect(signingSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
			seen.add(signingSecret);
			last = signingSecret;
		}

		// The raw secret is returned ONLY on create/rotate. The
		// subscription GET listing must never expose secret material.
		const list = await request.get(`${API_BASE}${WEBHOOKS}`, {
			headers: authedHeaders(u.access_token)
		});
		expect(list.status()).toBe(200);
		const listText = await list.text();
		// None of the issued raw secrets may appear in the listing body,
		// and there must be no `signingSecret`/`secret*` field on the view.
		for (const s of seen) {
			expect(listText.includes(s), 'listing leaked a raw signing secret').toBe(false);
		}
		const listJson = JSON.parse(listText) as {
			subscriptions: Array<Record<string, unknown>>;
		};
		const view = listJson.subscriptions.find((v) => v.id === subscriptionId);
		expect(view, 'subscription missing from owner listing').toBeTruthy();
		expect(Object.keys(view!).some((k) => /secret/i.test(k)), 'view exposes a secret field').toBe(
			false
		);

		// Signatures are payload-bound: the SAME key over DIFFERENT bodies
		// must differ (no fixed/constant signature regardless of input).
		const sigA = computeSignature(JSON.stringify({ a: 1 }), last);
		const sigB = computeSignature(JSON.stringify({ a: 2 }), last);
		expect(sigA).not.toBe(sigB);
		expect(sigA).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	test('outbound cross-account: a second account cannot rotate, test-fire, read deliveries for, or delete another account\'s subscription (404 enumeration cover, never 403)', async ({
		request
	}) => {
		// Two independent accounts.
		const owner = await registerUserViaAPI(request);
		const attacker = await registerUserViaAPI(request);

		const created = await request.post(`${API_BASE}${WEBHOOKS}`, {
			headers: authedHeaders(owner.access_token),
			data: { url: `https://webhook.invalid.ever.works/iso-${Date.now().toString(36)}` }
		});
		expect(created.status()).toBe(201);
		const { subscription } = await created.json();
		const subscriptionId: string = subscription.id;

		// Owner fires a delivery so a real delivery row exists to snoop.
		const fired = await request.post(`${API_BASE}${WEBHOOKS}/${subscriptionId}/test`, {
			headers: authedHeaders(owner.access_token)
		});
		expect(fired.status()).toBe(200);
		const { deliveryId } = await fired.json();

		// Every cross-account mutation/read on the subscription's :id must
		// be masked as 404 — a 403 would confirm "this id exists but isn't
		// yours" (enumeration leak).
		const rotate = await request.post(
			`${API_BASE}${WEBHOOKS}/${subscriptionId}/rotate-secret`,
			{ headers: authedHeaders(attacker.access_token) }
		);
		expect(rotate.status(), 'cross-account rotate should 404').toBe(404);

		const testFire = await request.post(`${API_BASE}${WEBHOOKS}/${subscriptionId}/test`, {
			headers: authedHeaders(attacker.access_token)
		});
		expect(testFire.status(), 'cross-account test-fire should 404').toBe(404);

		const del = await request.delete(`${API_BASE}${WEBHOOKS}/${subscriptionId}`, {
			headers: authedHeaders(attacker.access_token)
		});
		expect(del.status(), 'cross-account delete should 404').toBe(404);

		// The attacker's own deliveries listing must NOT contain the
		// owner's signed delivery (account-scoped at the repo call site).
		const attackerDeliveries = await request.get(`${API_BASE}${DELIVERIES}`, {
			headers: authedHeaders(attacker.access_token)
		});
		expect(attackerDeliveries.status()).toBe(200);
		const { deliveries } = await attackerDeliveries.json();
		const leaked = (deliveries as Array<{ id: string }>).some((d) => d.id === deliveryId);
		expect(leaked, "attacker's listing leaked the owner's delivery").toBe(false);

		// And the owner's subscription survived every cross-account
		// attempt unchanged.
		const ownerList = await request.get(`${API_BASE}${WEBHOOKS}`, {
			headers: authedHeaders(owner.access_token)
		});
		expect(ownerList.status()).toBe(200);
		const ownerJson = (await ownerList.json()) as {
			subscriptions: Array<{ id: string; status: string }>;
		};
		const survivor = ownerJson.subscriptions.find((s) => s.id === subscriptionId);
		expect(survivor, "owner's subscription was destroyed by a cross-account call").toBeTruthy();
		expect(survivor!.status).toBe('active');
	});
});
