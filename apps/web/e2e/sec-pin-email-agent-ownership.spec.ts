import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * SECURITY PINS — email compose agent-ownership (EW-711 Wave L #16) +
 * from-address scoping (Wave M #127) + verification-token lifecycle
 * (Wave M #44) on `apps/api/src/email/email.service.ts`.
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────
 * `flow-agent-inbox-messaging.spec.ts` already owns:
 *   · foreign agentId + FOREIGN fromAddressId → 404 "Agent not found"
 *   · own agent + foreign fromAddressId → 404 "From address not found"
 *   · no resolvable outbound address → 404; missing body → 400; valid
 *     send → provider boundary (500 keyless) with no phantom inbox row
 *   · bogus verify token → {verified:false} / good token → {verified:true}
 *     + token consumed (null in list); disabled address leaves the pool
 *   · cross-user inbox list scoping, message-detail 404 on a bogus id,
 *     cross-user PATCH/DELETE address → 404, anon 401 on message routes
 * `settings-integrations.spec.ts` owns anon 401 on GET addresses;
 * `notifications-v2-inbox.spec.ts` owns address create/list/delete CRUD.
 * This file pins ONLY the gaps: ownership-check ORDERING, the
 * no-existence-oracle equality, deleted-address from/verify lifecycle,
 * cross-user ADDRESS-LIST scoping, direction-filter partitioning,
 * token single-use + TTL stamp + entropy shape, DTO whitelist
 * validation (and its pipe-before-ownership ordering), and anon 401 on
 * the address MUTATION routes.
 *
 * ── PROBED CONTRACTS (live sqlite stack, http://127.0.0.1:3100) ────────
 *   POST /api/email/messages
 *     · foreign agentId, NO fromAddressId → 404 {message:'Agent not
 *       found', error:'Not Found'} — ownership fires BEFORE from-address
 *       resolution (the owner would get the no-outbound-address 404).
 *     · foreign agentId + caller's OWN valid fromAddressId + valid body
 *       → 404 'Agent not found'; no row lands in the agent owner's inbox.
 *     · foreign real id / zero-UUID / random string agentId → byte-equal
 *       404 bodies (no existence oracle).
 *     · DELETEd own fromAddressId → 404 'From address not found'.
 *     · unknown body property → 400 ['property evil should not exist']
 *       even when agentId is FOREIGN (ValidationPipe whitelist runs
 *       before ownership → 400, never 404); `to` non-email → 400 'each
 *       value in to must be an email'; 101 recipients → 400 'to must
 *       contain no more than 100 elements'; missing subject → 400
 *       includes 'subject must be a string'.
 *   GET /api/email/addresses[?direction=]
 *     · strictly caller-scoped: A never sees B's rows and vice versa.
 *     · ?direction=inbound|outbound returns only matching-direction rows;
 *       the unfiltered list is the superset.
 *   POST /api/email/addresses
 *     · 201 {address:{ verified:false }}. EW-025: `verificationToken` and
 *       `verificationTokenExpiresAt` are STRIPPED from every response — the
 *       token is 32-char base64url with a ~24h TTL server-side, but neither is
 *       observable, so the pins here assert their ABSENCE.
 *     · invalid email → 400 'address must be an email'; bad direction →
 *       400 'direction must be one of the following values: outbound,
 *       inbound, both'; unknown property → 400; missing providerSettings
 *       → 400 'providerSettings must be an object'.
 *   DELETE /api/email/addresses/:id → 204. (That deleting an address also
 *     invalidates its outstanding confirmation link is still true server-side
 *     but no longer assertable here — EW-025 removed the token.)
 *   GET /api/email/verify/:token (PUBLIC, throttled 10/min/IP) → always 200
 *     with EXACTLY {verified:bool} and no address data. A token matching
 *     nothing → false. The good-token and single-use branches need a real
 *     token, which EW-025 no longer exposes — recorded as gaps in the bodies.
 *   Anon (no bearer): POST/PATCH/DELETE /api/email/addresses[...] and
 *     POST /api/email/addresses/:id/verify → 401.
 *
 * NOTE: a REAL email_messages row is not creatable on this stack (the
 * keyless provider 500s before persistence; email plugins are disabled
 * so the inbound webhook 500s at plugin resolution), so the
 * real-foreign-row getMessage 404 stays pinned via the bogus-id
 * equivalence in the flow spec. All flows here are API-contract only —
 * fresh users per test, no mail read-back, no UI navigation.
 */

interface EmailAddress {
    id: string;
    userId: string;
    address: string;
    direction: 'outbound' | 'inbound' | 'both';
    pluginId: string;
    verified: boolean;
    /** EW-025: never sent over the API — optional so tests can assert ABSENCE. */
    verificationToken?: never;
    /** EW-025: stripped too — its value reveals how long a guess stays useful. */
    verificationTokenExpiresAt?: never;
    defaultForReplies: boolean;
    disabledAt: string | null;
}

interface ApiErrorBody {
    message: string | string[];
    error?: string;
    statusCode: number;
}

const NO_AGENT = 'Agent not found';
const NO_FROM = 'From address not found';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_SLACK_MS = 5 * 60 * 1000;

function uniq(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createAddress(
    request: APIRequestContext,
    token: string,
    overrides: { direction?: 'outbound' | 'inbound' } = {},
): Promise<EmailAddress> {
    const res = await request.post(`${API_BASE}/api/email/addresses`, {
        headers: authedHeaders(token),
        data: {
            address: `${uniq('sec-pin')}@example.com`,
            direction: overrides.direction ?? 'outbound',
            pluginId: 'postmark',
            providerSettings: { apiKey: 'ci-fake-key' },
        },
    });
    expect(res.status(), `createAddress body=${await res.text().catch(() => '')}`).toBe(201);
    return ((await res.json()) as { address: EmailAddress }).address;
}

function sendMessage(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<APIResponse> {
    return request.post(`${API_BASE}/api/email/messages`, {
        headers: authedHeaders(token),
        data: body,
    });
}

async function listAddresses(
    request: APIRequestContext,
    token: string,
    direction?: 'outbound' | 'inbound',
): Promise<EmailAddress[]> {
    const qs = direction ? `?direction=${direction}` : '';
    const res = await request.get(`${API_BASE}/api/email/addresses${qs}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { addresses: EmailAddress[] }).addresses;
}

test.describe('Email security pins — agent ownership, address scoping, verification lifecycle', () => {
    // ------------------------------------------------------------------
    // Wave L #16 — compose agent-ownership ORDERING
    // ------------------------------------------------------------------

    test('compose with a foreign agentId 404s on ownership BEFORE from-address resolution', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: uniq('Sec owner agent'),
            scope: 'tenant',
        });

        // The intruder supplies NO fromAddressId. If from-address resolution
        // ran first, the response would be the "Agent has no outbound email
        // address assigned" 404 — the ownership guard must win instead, so a
        // foreign caller learns nothing about the agent's address wiring.
        const res = await sendMessage(request, intruder.access_token, {
            agentId: agent.id,
            to: ['dest@example.com'],
            subject: uniq('s'),
            bodyText: 'b',
        });
        expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(404);
        const body = (await res.json()) as ApiErrorBody;
        expect(body.message).toBe(NO_AGENT);
        expect(body.message).not.toContain('outbound email address');
    });

    test('a caller-owned valid from-address cannot launder a send through a foreign agent', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: uniq('Sec launder agent'),
            scope: 'tenant',
        });
        // The intruder's OWN address is fully valid and caller-scoped — yet
        // it must not unlock a send attributed to someone else's agent.
        const intruderAddr = await createAddress(request, intruder.access_token);

        const res = await sendMessage(request, intruder.access_token, {
            agentId: agent.id,
            fromAddressId: intruderAddr.id,
            to: ['dest@example.com'],
            subject: uniq('s'),
            bodyText: 'real body present',
        });
        expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(404);
        expect(((await res.json()) as ApiErrorBody).message).toBe(NO_AGENT);

        // Nothing lands in the agent owner's audit trail for that agent.
        const ownerInbox = await request.get(`${API_BASE}/api/email/messages?agentId=${agent.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerInbox.status()).toBe(200);
        const { messages } = (await ownerInbox.json()) as { messages: unknown[] };
        expect(messages.length, 'rejected foreign send must not create an audit row').toBe(0);
    });

    test('foreign, zero-UUID, and garbage agentIds yield byte-identical 404s (no existence oracle)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: uniq('Sec oracle agent'),
            scope: 'tenant',
        });
        const intruderAddr = await createAddress(request, intruder.access_token);

        const probeIds = [agent.id, ZERO_UUID, uniq('not-an-agent')];
        const bodies: ApiErrorBody[] = [];
        for (const agentId of probeIds) {
            const res = await sendMessage(request, intruder.access_token, {
                agentId,
                fromAddressId: intruderAddr.id,
                to: ['dest@example.com'],
                subject: uniq('s'),
                bodyText: 'b',
            });
            expect(res.status(), `agentId=${agentId}`).toBe(404);
            bodies.push((await res.json()) as ApiErrorBody);
        }
        // A real-but-foreign agent must be indistinguishable from one that
        // never existed — same status, same message, same envelope.
        for (const body of bodies) {
            expect(body).toEqual({ message: NO_AGENT, error: 'Not Found', statusCode: 404 });
        }
    });

    // ------------------------------------------------------------------
    // Wave M #127 — from-address + address-list scoping
    // ------------------------------------------------------------------

    test('a deleted own from-address is unusable for sends', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: uniq('Sec deleted-from agent'),
            scope: 'tenant',
        });
        const addr = await createAddress(request, user.access_token);

        const del = await request.delete(`${API_BASE}/api/email/addresses/${addr.id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(del.status()).toBe(204);

        // Explicitly naming the deleted row must fail closed — the same 404
        // a foreign fromAddressId yields, so deletion really revokes use.
        const res = await sendMessage(request, user.access_token, {
            agentId: agent.id,
            fromAddressId: addr.id,
            to: ['dest@example.com'],
            subject: uniq('s'),
            bodyText: 'b',
        });
        expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(404);
        expect(((await res.json()) as ApiErrorBody).message).toBe(NO_FROM);
    });

    test('the address list is strictly caller-scoped in both directions', async ({ request }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const addrA = await createAddress(request, userA.access_token);
        const addrB = await createAddress(request, userB.access_token);

        const aAll = await listAddresses(request, userA.access_token);
        const bAll = await listAddresses(request, userB.access_token);

        expect(
            aAll.some((x) => x.id === addrA.id),
            'A sees A’s own address',
        ).toBe(true);
        expect(
            aAll.some((x) => x.id === addrB.id),
            'A must never see B’s address',
        ).toBe(false);
        expect(
            bAll.some((x) => x.id === addrB.id),
            'B sees B’s own address',
        ).toBe(true);
        expect(
            bAll.some((x) => x.id === addrA.id),
            'B must never see A’s address',
        ).toBe(false);

        // The direction filter narrows but never widens the scope.
        const aOutbound = await listAddresses(request, userA.access_token, 'outbound');
        expect(aOutbound.some((x) => x.id === addrB.id)).toBe(false);
        expect(aOutbound.some((x) => x.id === addrA.id)).toBe(true);
    });

    test('direction filter partitions the caller’s addresses without leaking across directions', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const outAddr = await createAddress(request, user.access_token, { direction: 'outbound' });
        const inAddr = await createAddress(request, user.access_token, { direction: 'inbound' });

        const inbound = await listAddresses(request, user.access_token, 'inbound');
        expect(inbound.some((x) => x.id === inAddr.id)).toBe(true);
        expect(inbound.some((x) => x.id === outAddr.id)).toBe(false);
        for (const row of inbound) expect(row.direction).toBe('inbound');

        const outbound = await listAddresses(request, user.access_token, 'outbound');
        expect(outbound.some((x) => x.id === outAddr.id)).toBe(true);
        expect(outbound.some((x) => x.id === inAddr.id)).toBe(false);
        for (const row of outbound) expect(row.direction).toBe('outbound');

        // Unfiltered list is the superset of both partitions.
        const all = await listAddresses(request, user.access_token);
        expect(all.some((x) => x.id === inAddr.id)).toBe(true);
        expect(all.some((x) => x.id === outAddr.id)).toBe(true);
    });

    // ------------------------------------------------------------------
    // Wave M #44 — verification-token lifecycle
    // ------------------------------------------------------------------

    test('verification tokens are single-use — a confirmed link cannot be replayed', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);

        // EW-025 — the STRONGER pin, and the one this file should lead with:
        // the token never crosses the API boundary at all. A single-use token
        // that an attacker can read from a 201 body is not much of a defence;
        // the fix removed the exposure, so assert the exposure is gone.
        expect(addr.verificationToken).toBeUndefined();

        // Still assertable without a real token: the PUBLIC confirm endpoint is
        // not an existence oracle. An unknown token answers 200 with exactly
        // one key and no detail — the property that stops it being used to
        // enumerate addresses or distinguish "wrong" from "already used".
        const bogus = await request.get(`${API_BASE}/api/email/verify/${'z'.repeat(32)}`);
        expect(bogus.status()).toBe(200);
        const bogusBody = (await bogus.json()) as Record<string, unknown>;
        expect(bogusBody.verified).toBe(false);
        expect(Object.keys(bogusBody)).toEqual(['verified']);

        // ── COVERAGE GAP, deliberate and recorded ────────────────────────────
        // Single-use (a confirmed link cannot be replayed) is a real invariant
        // and is NO LONGER reachable from an e2e test: reaching it requires a
        // valid token, which EW-025 removed from every response, and the
        // emailed copy goes via the provider plugin rather than the MailHog
        // sink the e2e stack runs. It needs unit coverage over
        // `EmailService.confirmVerification` (which nulls the token on success)
        // — not deletion. Recorded so the property is not quietly lost.
    });

    test('fresh addresses carry a time-boxed, high-entropy verification token', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const before = Date.now();
        const addr1 = await createAddress(request, user.access_token);
        const addr2 = await createAddress(request, user.access_token);

        for (const addr of [addr1, addr2]) {
            expect(addr.verified).toBe(false);
            // EW-025 — neither the token NOR its expiry may cross the API
            // boundary. The expiry is stripped too, on purpose: publishing it
            // tells an attacker exactly how long a guessed token stays useful.
            expect(addr.verificationToken).toBeUndefined();
            expect(addr.verificationTokenExpiresAt).toBeUndefined();
        }
        // `before` is retained deliberately — it documents that this test used
        // to bound the TTL stamp, so whoever restores that coverage knows what
        // was asserted.
        expect(before).toBeLessThanOrEqual(Date.now());

        // ── COVERAGE GAP, deliberate and recorded ────────────────────────────
        // Three invariants were pinned here and are now unobservable, because
        // the values they inspect are no longer returned:
        //   · 24 bytes of randomness → exactly 32 url-safe base64 chars,
        //     i.e. /^[A-Za-z0-9_-]{32}$/
        //   · a TTL stamped at issuance, in the future and no further out than
        //     DAY_MS + TTL_SLACK_MS (EW-711 #44) — the constants are kept below
        //     so the exact bound survives for whoever rewrites this as a unit test
        //   · tokens unique per address — no shared/global confirmation link
        // All three are properties of the ISSUER, so they belong in a unit test
        // over the token-minting path rather than in an API-contract spec. They
        // are listed here rather than dropped so the loss is visible.
        expect(DAY_MS + TTL_SLACK_MS).toBe(24 * 60 * 60 * 1000 + 5 * 60 * 1000);
    });

    test('deleting an address invalidates its outstanding verification link', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);
        // EW-025 — the token is not returned, so this test can no longer hold
        // the link it wants to prove dead. See the recorded gap below.
        expect(addr.verificationToken).toBeUndefined();

        const del = await request.delete(`${API_BASE}/api/email/addresses/${addr.id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(del.status()).toBe(204);
        const remaining = await listAddresses(request, user.access_token);
        expect(remaining.some((x) => x.id === addr.id)).toBe(false);

        // ── COVERAGE GAP, deliberate and recorded ────────────────────────────
        // The property this test is named for — a leaked email for a RETIRED
        // address can never flip anything to verified — needs the deleted row's
        // token, which EW-025 no longer returns. It belongs in a unit test over
        // `EmailAddressRepository.delete` / `confirmVerification` now.
        //
        // What remains assertable is the half that does not need the token: the
        // row is gone from the caller's list, and the public confirm endpoint
        // stays a non-oracle for a token that matches nothing.
        const verify = await request.get(`${API_BASE}/api/email/verify/${'y'.repeat(32)}`);
        expect(verify.status()).toBe(200);
        expect(((await verify.json()) as { verified: boolean }).verified).toBe(false);
    });

    // ------------------------------------------------------------------
    // DTO whitelist validation (security hardening on the @Body classes)
    // ------------------------------------------------------------------

    test('send-message bodies are whitelist-validated, and validation precedes ownership', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: uniq('Sec dto agent'),
            scope: 'tenant',
        });

        // Unknown property on a FOREIGN agentId → the pipe's 400 wins (the
        // ownership 404 never runs), so mass-assignment is rejected at the
        // boundary for every caller.
        const evil = await sendMessage(request, intruder.access_token, {
            agentId: agent.id,
            to: ['dest@example.com'],
            subject: uniq('s'),
            bodyText: 'b',
            evil: true,
        });
        expect(evil.status(), `body=${await evil.text().catch(() => '')}`).toBe(400);
        expect((await evil.json()).message).toContain('property evil should not exist');

        // Recipient strings must be emails…
        const badTo = await sendMessage(request, intruder.access_token, {
            agentId: agent.id,
            to: ['not-an-email'],
            subject: uniq('s'),
            bodyText: 'b',
        });
        expect(badTo.status()).toBe(400);
        expect((await badTo.json()).message).toContain('each value in to must be an email');

        // …capped at 100 recipients…
        const tooMany = await sendMessage(request, intruder.access_token, {
            agentId: agent.id,
            to: Array.from({ length: 101 }, (_, i) => `r${i}@example.com`),
            subject: uniq('s'),
            bodyText: 'b',
        });
        expect(tooMany.status()).toBe(400);
        expect((await tooMany.json()).message).toContain(
            'to must contain no more than 100 elements',
        );

        // …and subject is mandatory.
        const noSubject = await sendMessage(request, intruder.access_token, {
            agentId: agent.id,
            to: ['dest@example.com'],
            bodyText: 'b',
        });
        expect(noSubject.status()).toBe(400);
        expect((await noSubject.json()).message).toContain('subject must be a string');
    });

    test('address creation is whitelist-validated (email shape, direction enum, no extra props)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const post = (data: Record<string, unknown>) =>
            request.post(`${API_BASE}/api/email/addresses`, { headers, data });

        const badEmail = await post({
            address: 'not-an-email',
            direction: 'outbound',
            pluginId: 'postmark',
            providerSettings: {},
        });
        expect(badEmail.status()).toBe(400);
        expect((await badEmail.json()).message).toContain('address must be an email');

        const badDirection = await post({
            address: `${uniq('ok')}@example.com`,
            direction: 'sideways',
            pluginId: 'postmark',
            providerSettings: {},
        });
        expect(badDirection.status()).toBe(400);
        expect((await badDirection.json()).message).toContain(
            'direction must be one of the following values: outbound, inbound, both',
        );

        // forbidNonWhitelisted: a smuggled privilege-looking field is rejected,
        // not silently stripped-and-accepted.
        const extraProp = await post({
            address: `${uniq('ok')}@example.com`,
            direction: 'outbound',
            pluginId: 'postmark',
            providerSettings: {},
            admin: true,
        });
        expect(extraProp.status()).toBe(400);
        expect((await extraProp.json()).message).toContain('property admin should not exist');

        const noSettings = await post({
            address: `${uniq('ok')}@example.com`,
            direction: 'outbound',
            pluginId: 'postmark',
        });
        expect(noSettings.status()).toBe(400);
        expect((await noSettings.json()).message).toContain('providerSettings must be an object');
    });

    // ------------------------------------------------------------------
    // Auth boundary on the address MUTATION routes
    // ------------------------------------------------------------------

    test('all address mutation routes reject anonymous callers with 401', async ({ request }) => {
        // A real row to aim the anonymous mutations at (proves the 401 is the
        // auth guard, not a missing-row 404).
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);

        const anonCreate = await request.post(`${API_BASE}/api/email/addresses`, {
            data: {
                address: `${uniq('anon')}@example.com`,
                direction: 'outbound',
                pluginId: 'postmark',
                providerSettings: {},
            },
        });
        expect(anonCreate.status()).toBe(401);

        const anonPatch = await request.patch(`${API_BASE}/api/email/addresses/${addr.id}`, {
            data: { disabled: true },
        });
        expect(anonPatch.status()).toBe(401);

        const anonDelete = await request.delete(`${API_BASE}/api/email/addresses/${addr.id}`);
        expect(anonDelete.status()).toBe(401);

        const anonVerifyTrigger = await request.post(
            `${API_BASE}/api/email/addresses/${addr.id}/verify`,
        );
        expect(anonVerifyTrigger.status()).toBe(401);

        // The anonymous attempts were no-ops: the row is still active and
        // untouched for its owner.
        const list = await listAddresses(request, user.access_token);
        const row = list.find((x) => x.id === addr.id);
        expect(row?.disabledAt ?? null).toBeNull();
    });
});
