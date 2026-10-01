/**
 * APW-13 T17 — GitHub event intake: a validly signed delivery, end to end.
 *
 * Covers **ACC-REG-12** ("GitHub event intake — merge → Build trigger (D6)"),
 * whose recorded verdict was *Partial — no validly signed delivery end to end*.
 * This spec is the missing half: it signs a delivery itself with the CI webhook
 * secret and drives the REAL receiver, so the signature gate is exercised in
 * both directions on one live stack.
 *
 * ── The route and the scheme, read out of the code (not guessed):
 *
 *   • `POST /api/ingest/github/events` — the CANONICAL receiver
 *     (`apps/api/src/ingest/github/github-events.controller.ts:38`), public and
 *     secured by request signing. The platform GitHub App webhook,
 *     `POST /api/github-app/webhooks`, is a thin forwarder onto the same
 *     `GitHubWebhookDispatcherService` (`github-app-webhook.controller.ts:61`),
 *     so both URLs are driven here — they are one receiver with two status
 *     contracts.
 *   • `x-hub-signature-256: sha256=HEX(HMAC_SHA256(secret, RAW_BODY))` over the
 *     exact bytes sent (`apps/api/src/ingest/github/github-signature.util.ts:35-38`).
 *     The raw body is captured by the `bodyParser` `verify` hook
 *     (`apps/api/src/main.ts:92-98,144`), so re-serialising the JSON is NOT
 *     equivalent — the tampered-body case below pins exactly that.
 *   • The secret is the platform App webhook secret
 *     (`config.githubApp.webhookSecret()` → `GITHUB_APP_WEBHOOK_SECRET`,
 *     `apps/api/src/config/constants.ts`, the variable the CI lane sets at
 *     `.github/workflows/e2e.yml:424`). The per-install `webhookSecret` of an
 *     enabled `github` plugin install is the OTHER accepted credential
 *     (`github.plugin.ts`), and it is unreachable from the PR lane until T63's
 *     connection surface lands — which is why the acceptance and fan-out half
 *     below runs against the app-secret credential only.
 *   • The one refusal body is `Invalid GitHub webhook signature`
 *     (`INVALID_GITHUB_SIGNATURE`, `github-webhook-dispatcher.service.ts:63`) for
 *     every unverifiable delivery — missing secret, missing signature or a
 *     mismatch — so the receiver never becomes a configuration oracle.
 *
 * ── What "fans out" is proven to mean here (the honest boundary):
 *
 * A delivery that verifies against the platform App secret is dispatched, and
 * the dispatcher's consumer fan-out runs (`dispatch()` → the App-sync leg, then
 * the review and registered-intake legs). With no install binding on a fresh
 * lane the review/intake legs are deliberately SKIPPED rather than guessed
 * (`github-webhook-dispatcher.service.ts:324-337`), so this spec pins:
 *
 *   • the canonical route answers `200 { ok: true }` with NO `ignored` key —
 *     the accepted-and-dispatched shape, contrasted with the 401 a delivery that
 *     never verified gets;
 *   • the legacy route answers `201 { ok: true }` for an `installation` event,
 *     and that route RETHROWS the App-sync consumer's failure
 *     (`github-app-webhook.controller.ts:87-89`) — so a 2xx there is only
 *     reachable when the fan-out consumer actually ran and completed;
 *   • `x-github-event` and a raw body are required BEFORE verification (400),
 *     so a malformed delivery cannot be mistaken for a signed one.
 *
 * The review/intake legs need an install binding (`T63`, plan §8.8), and the
 * `ignored` no-op shape they produce is unreachable while no `github` plugin
 * install exists on the deployment — recorded here rather than asserted.
 *
 * Verified live against http://127.0.0.1:3100 before these assertions were
 * written (2026-09-18): signed `push` → `200 {"ok":true}`; signed `installation`
 * on the legacy route → `201 {"ok":true}`; unsigned, wrong-secret and
 * tampered-body deliveries → `401 {"message":"Invalid GitHub webhook
 * signature"}` on both routes.
 */
import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_BASE } from './helpers/api';

/** The canonical receiver (`github-events.controller.ts`). */
const CANONICAL_INTAKE_URL = `${API_BASE}/api/ingest/github/events`;

/** The platform App webhook URL — a forwarder onto the same dispatcher. */
const LEGACY_INTAKE_URL = `${API_BASE}/api/github-app/webhooks`;

/**
 * The one 401 body both routes answer for an unverifiable delivery.
 * Identical for a missing signature, a wrong secret and no configured secret.
 */
const INVALID_SIGNATURE_MESSAGE = 'Invalid GitHub webhook signature';

/** The CI webhook secret — the same variable the API process reads. */
const WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET;

/** A well-formed secret that is not the configured one. */
const WRONG_SECRET = 'apw13-wrong-webhook-secret-0123456789abcdef';

/**
 * A `push` delivery. `push` is one of the dispatcher's APP_STATE_EVENTS
 * (`github-webhook-dispatcher.service.ts:53`), i.e. an event whose sync leg is
 * gated on the platform App credential — so accepting it is evidence the
 * app-secret path was taken, not merely that some secret verified.
 */
const PUSH_PAYLOAD = JSON.stringify({
    ref: 'refs/heads/main',
    before: '0000000000000000000000000000000000000000',
    repository: {
        id: 990001,
        name: 'apw13-intake-probe',
        full_name: 'ever-works/apw13-intake-probe',
        owner: { login: 'ever-works' },
        private: false,
        default_branch: 'main',
    },
    sender: { id: 424242, login: 'apw13-probe-sender', type: 'User' },
});

/** An `installation` delivery whose sync leg is DB-only (a delete, no API call). */
const INSTALLATION_DELETED_PAYLOAD = JSON.stringify({
    action: 'deleted',
    installation: { id: 987654, account: { login: 'ever-works', type: 'Organization' } },
    sender: { id: 424242, login: 'apw13-probe-sender', type: 'User' },
});

/** The `sha256=<hex>` signature GitHub sends, computed over the exact bytes. */
function sign(secret: string, rawBody: string): string {
    return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

interface DeliveryAnswer {
    status: number;
    text: string;
    /** The canonical route's body, when it parsed. */
    json: { ok?: boolean; ignored?: unknown } | null;
}

/**
 * Deliver one webhook. Never throws on a status: the refusal IS the assertion.
 * The body is sent as the exact string handed in — Playwright does not
 * re-serialise a string `data` — which is what makes the signature meaningful.
 */
async function deliver(
    request: APIRequestContext,
    url: string,
    delivery: { body: string; event?: string; signature?: string },
): Promise<DeliveryAnswer> {
    const res = await request.post(url, {
        headers: {
            'content-type': 'application/json',
            ...(delivery.event ? { 'x-github-event': delivery.event } : {}),
            ...(delivery.signature ? { 'x-hub-signature-256': delivery.signature } : {}),
        },
        data: delivery.body,
    });
    const text = await res.text();
    let json: DeliveryAnswer['json'] = null;
    try {
        json = JSON.parse(text) as DeliveryAnswer['json'];
    } catch {
        json = null;
    }
    return { status: res.status(), text, json };
}

test.describe('GitHub intake — a delivery signed with the CI webhook secret', () => {
    test('is accepted and dispatched on the canonical route (200, no ignored no-op)', async ({
        request,
    }) => {
        test.skip(
            !WEBHOOK_SECRET,
            'GITHUB_APP_WEBHOOK_SECRET is not set for this process. The API reads the SAME ' +
                'variable (apps/api/src/config/constants.ts → config.githubApp.webhookSecret()), ' +
                'so without it no delivery can be signed here and the acceptance half is ' +
                'unobservable. The PR lane sets it (.github/workflows/e2e.yml:424).',
        );

        const answer = await deliver(request, CANONICAL_INTAKE_URL, {
            body: PUSH_PAYLOAD,
            event: 'push',
            signature: sign(WEBHOOK_SECRET as string, PUSH_PAYLOAD),
        });

        expect(
            answer.status,
            `signed push must be accepted, body=${answer.text.slice(0, 300)}`,
        ).toBe(200);
        expect(answer.json?.ok, 'the accepted delivery answers { ok: true }').toBe(true);
        expect(
            answer.json?.ignored,
            'an accepted app-secret delivery is dispatched, not the unattributable no-op ' +
                '(the `ignored` key is only emitted on the install-secret branch)',
        ).toBeUndefined();
    });

    test('is accepted on the legacy App webhook route, where a consumer failure would be rethrown', async ({
        request,
    }) => {
        test.skip(
            !WEBHOOK_SECRET,
            'GITHUB_APP_WEBHOOK_SECRET is not set for this process — see the canonical test above.',
        );

        const answer = await deliver(request, LEGACY_INTAKE_URL, {
            body: INSTALLATION_DELETED_PAYLOAD,
            event: 'installation',
            signature: sign(WEBHOOK_SECRET as string, INSTALLATION_DELETED_PAYLOAD),
        });

        // This route rethrows `result.errors.sync` (github-app-webhook.controller.ts:87-89),
        // so a 2xx is only reachable when the App-sync consumer ran and completed.
        expect(
            answer.status,
            `signed installation delivery body=${answer.text.slice(0, 300)}`,
        ).toBe(201);
        expect(answer.json?.ok, 'the legacy route answers { ok: true }').toBe(true);
    });
});

test.describe('GitHub intake — fail-closed refusals in the same spec', () => {
    test('an unsigned delivery is refused (401) with the one refusal body', async ({ request }) => {
        const answer = await deliver(request, CANONICAL_INTAKE_URL, {
            body: PUSH_PAYLOAD,
            event: 'push',
        });

        expect(answer.status, `unsigned body=${answer.text.slice(0, 300)}`).toBe(401);
        expect(answer.text).toContain(INVALID_SIGNATURE_MESSAGE);
    });

    test('the same unsigned delivery is refused on the legacy route too', async ({ request }) => {
        const answer = await deliver(request, LEGACY_INTAKE_URL, {
            body: PUSH_PAYLOAD,
            event: 'push',
        });

        expect(answer.status, `unsigned body=${answer.text.slice(0, 300)}`).toBe(401);
        expect(answer.text).toContain(INVALID_SIGNATURE_MESSAGE);
    });

    test('a delivery signed with the wrong secret is refused (401)', async ({ request }) => {
        const answer = await deliver(request, CANONICAL_INTAKE_URL, {
            body: PUSH_PAYLOAD,
            event: 'push',
            signature: sign(WRONG_SECRET, PUSH_PAYLOAD),
        });

        expect(answer.status, `wrong secret body=${answer.text.slice(0, 300)}`).toBe(401);
        expect(answer.text).toContain(INVALID_SIGNATURE_MESSAGE);
    });

    test('a body tampered with after signing is refused (401) — the HMAC covers the raw bytes', async ({
        request,
    }) => {
        test.skip(
            !WEBHOOK_SECRET,
            'GITHUB_APP_WEBHOOK_SECRET is not set for this process — the tampered-body case ' +
                'needs a valid signature over the ORIGINAL bytes to be meaningfully refused.',
        );

        const tampered = PUSH_PAYLOAD.replace('refs/heads/main', 'refs/heads/evil');
        const answer = await deliver(request, CANONICAL_INTAKE_URL, {
            body: tampered,
            event: 'push',
            signature: sign(WEBHOOK_SECRET as string, PUSH_PAYLOAD),
        });

        expect(answer.status, `tampered body=${answer.text.slice(0, 300)}`).toBe(401);
        expect(answer.text).toContain(INVALID_SIGNATURE_MESSAGE);
    });

    test('the refusal never reveals whether a secret is configured (byte-identical bodies)', async ({
        request,
    }) => {
        const unsigned = await deliver(request, CANONICAL_INTAKE_URL, {
            body: PUSH_PAYLOAD,
            event: 'push',
        });
        const wrongSecret = await deliver(request, CANONICAL_INTAKE_URL, {
            body: PUSH_PAYLOAD,
            event: 'push',
            signature: sign(WRONG_SECRET, PUSH_PAYLOAD),
        });

        expect(unsigned.status).toBe(401);
        expect(wrongSecret.status).toBe(401);
        expect(
            wrongSecret.text,
            'a prober must not be able to tell "no signature" from "wrong secret"',
        ).toBe(unsigned.text);
    });

    test('the event header is required, and an unparseable body never reaches the receiver', async ({
        request,
    }) => {
        test.skip(
            !WEBHOOK_SECRET,
            'GITHUB_APP_WEBHOOK_SECRET is not set for this process — these cases are signed.',
        );

        const noEventHeader = await deliver(request, CANONICAL_INTAKE_URL, {
            body: PUSH_PAYLOAD,
            signature: sign(WEBHOOK_SECRET as string, PUSH_PAYLOAD),
        });
        expect(
            noEventHeader.status,
            `missing event header body=${noEventHeader.text.slice(0, 200)}`,
        ).toBe(400);
        expect(noEventHeader.text).toContain('Missing GitHub event header');

        // The raw body is captured by the JSON body parser
        // (`apps/api/src/main.ts:144`), so bytes that are not JSON are refused
        // there — the dispatcher's own `Missing raw request payload` guard is
        // unreachable from HTTP, because any body that reaches it parsed.
        const notJson = await deliver(request, CANONICAL_INTAKE_URL, {
            body: 'not json at all',
            event: 'push',
            signature: sign(WEBHOOK_SECRET as string, 'not json at all'),
        });
        expect(notJson.status, `unparseable body=${notJson.text.slice(0, 200)}`).toBe(400);
        expect(notJson.text).not.toContain(INVALID_SIGNATURE_MESSAGE);
    });
});
