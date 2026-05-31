import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * API keys — deep lifecycle, expiry-enforcement, and cross-user isolation flows.
 *
 * These are multi-step, cross-feature integrations that drive the REAL platform
 * end-to-end and assert observable outcomes at each step. They intentionally go
 * beyond the shallow create/list/revoke smoke in `api-keys.spec.ts` and
 * `api-keys-lifecycle.spec.ts` by proving:
 *   - the issued `ew_live_…` secret actually AUTHENTICATES real API requests
 *     (via both `x-api-key` and `Authorization: Bearer`) and resolves to the
 *     OWNER's identity — checked against /api/auth/profile/fresh,
 *   - the secret is shown ONCE and the list view masks it down to a `prefix`,
 *   - revocation is immediate (revoked key → 401 on the very next request), and
 *   - server-side EXPIRY is enforced, not merely recorded (a short-lived key
 *     works before its `expiresAt`, then 401s after).
 *
 * Verified against the live stack (probe-first) — exact shapes asserted below:
 *   POST   /api/auth/api-keys      DTO { name (required, ≤100), expiresAt? (ISO) }
 *                                  → 201 { id, name, key:"ew_live_"+64hex (72 chars),
 *                                          prefix:"ew_live_"+4hex (12 chars), expiresAt, createdAt }
 *                                  → 400 "Expiration date must be in the future" (past expiresAt)
 *                                  → 400 ["name should not be empty"] (empty name)
 *   GET    /api/auth/api-keys      → 200 [{ id, name, prefix, expiresAt, lastUsedAt, isActive, createdAt }]
 *                                    (NO `key`, NO `hashedKey` — list is owner-scoped + masked)
 *   DELETE /api/auth/api-keys/:id  → 200 { message } (owner) | 404 (non-owner / already gone)
 *   Auth guard: `x-api-key: ew_live_…` OR `Authorization: Bearer ew_live_…` authenticates as
 *               the key's owner; invalid/revoked/expired → 401 "Invalid or expired API key".
 *
 * Isolation note: the guard maps an API key to its OWNER, so "user A's key acting
 * as user B" is structurally impossible — the truthful isolation assertions are
 * (a) A's key always resolves to A's identity (never B's), (b) each user's list
 * shows only their own keys, and (c) B cannot revoke A's key (404, A's key survives).
 *
 * Cross-spec isolation: every flow runs on FRESH registerUserViaAPI() users (never the
 * shared seeded user) so a user-scoped key never leaks into sibling specs.
 */

const PROFILE_FRESH = `${API_BASE}/api/auth/profile/fresh`;
const KEYS = `${API_BASE}/api/auth/api-keys`;

interface CreatedKey {
    id: string;
    name: string;
    key: string;
    prefix: string;
    expiresAt: string | null;
    createdAt: string;
}

interface ListedKey {
    id: string;
    name: string;
    prefix: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    isActive: boolean;
    createdAt: string;
}

async function createKey(
    request: APIRequestContext,
    token: string,
    body: { name: string; expiresAt?: string },
): Promise<CreatedKey> {
    const res = await request.post(KEYS, { headers: authedHeaders(token), data: body });
    expect(res.status(), `create key body=${await res.text().catch(() => '<no body>')}`).toBe(201);
    return res.json();
}

async function listKeys(request: APIRequestContext, token: string): Promise<ListedKey[]> {
    const res = await request.get(KEYS, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body), 'list endpoint returns an array').toBe(true);
    return body;
}

test.describe('API keys — lifecycle, expiry, isolation', () => {
    test('issued key authenticates real requests, is masked in the list, then is revoked', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        // 1. Create a key. The plaintext secret is returned exactly ONCE here.
        const created = await createKey(request, owner.access_token, {
            name: `lifecycle-${Date.now()}`,
        });
        expect(created.id, 'created key has an id').toBeTruthy();
        expect(created.key, 'plaintext secret returned on create').toMatch(
            /^ew_live_[0-9a-f]{64}$/,
        );
        expect(created.key).toHaveLength(72); // "ew_live_" (8) + 32 bytes hex (64)
        expect(created.prefix, 'prefix is the 12-char non-secret fingerprint').toBe(
            created.key.substring(0, 12),
        );
        expect(created.expiresAt, 'no expiry requested → null').toBeNull();

        // 2. The secret really authenticates API requests — via BOTH accepted slots —
        //    and resolves to the OWNER's identity (the guard synthesises request.user).
        const viaHeader = await request.get(PROFILE_FRESH, {
            headers: { 'x-api-key': created.key },
        });
        expect(viaHeader.status(), 'x-api-key authenticates').toBe(200);
        const headerProfile = await viaHeader.json();
        expect(headerProfile.email, 'key resolves to its owner').toBe(owner.user.email);
        expect(headerProfile.id).toBe(owner.user.id);

        const viaBearer = await request.get(PROFILE_FRESH, {
            headers: authedHeaders(created.key), // Authorization: Bearer ew_live_…
        });
        expect(viaBearer.status(), 'Bearer ew_live_… also authenticates').toBe(200);
        expect((await viaBearer.json()).email).toBe(owner.user.email);

        // 3. List masks the secret: only the `prefix` is exposed, never the raw key
        //    nor the stored hash. Using the key advances `lastUsedAt`.
        const afterUse = await listKeys(request, owner.access_token);
        const listed = afterUse.find((k) => k.id === created.id);
        expect(listed, 'created key appears in the owner list').toBeTruthy();
        expect(listed!.prefix).toBe(created.prefix);
        expect(listed!.isActive).toBe(true);
        expect(listed!.lastUsedAt, 'authenticated use stamps lastUsedAt').toBeTruthy();
        const serialized = JSON.stringify(afterUse);
        expect(serialized.includes(created.key), 'raw secret never appears in list').toBe(false);
        // No row carries a SHA-256-looking 64-hex `hashedKey` field.
        for (const k of afterUse) {
            const row = k as unknown as Record<string, unknown>;
            expect(row.hashedKey, 'hashedKey never serialized').toBeUndefined();
            expect(row.key, 'raw key never serialized').toBeUndefined();
        }

        // 4. Revoke the key.
        const revoke = await request.delete(`${KEYS}/${created.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(revoke.status(), 'owner revoke succeeds').toBe(200);
        expect((await revoke.json()).message).toMatch(/revoked/i);

        // 5. The revoked key 401s immediately on the very next authenticated request.
        const afterRevoke = await request.get(PROFILE_FRESH, {
            headers: { 'x-api-key': created.key },
        });
        expect(afterRevoke.status(), 'revoked key is rejected').toBe(401);
        expect((await afterRevoke.json()).message).toMatch(/invalid or expired api key/i);

        // 6. Revoking again is a no-op 404 (already gone), and the key is no longer listed.
        const revokeAgain = await request.delete(`${KEYS}/${created.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(revokeAgain.status(), 'second revoke → 404').toBe(404);
        const finalList = await listKeys(request, owner.access_token);
        expect(
            finalList.find((k) => k.id === created.id),
            'revoked key dropped from list',
        ).toBeFalsy();
    });

    test('expiry is recorded AND enforced: short-lived key works, then 401s after it lapses', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        // The DTO rejects non-future / malformed expiry up front.
        const past = await request.post(KEYS, {
            headers: authedHeaders(owner.access_token),
            data: { name: 'past', expiresAt: '2020-01-01T00:00:00.000Z' },
        });
        expect(past.status(), 'past expiry rejected').toBe(400);
        expect((await past.json()).message).toMatch(/expiration date must be in the future/i);

        const malformed = await request.post(KEYS, {
            headers: authedHeaders(owner.access_token),
            data: { name: 'bad', expiresAt: 'not-a-date' },
        });
        expect(malformed.status(), 'malformed expiry rejected').toBe(400);
        expect(JSON.stringify((await malformed.json()).message)).toMatch(/iso 8601 date string/i);

        // A documented future expiry is recorded verbatim on the key + in the list.
        const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const longLived = await createKey(request, owner.access_token, {
            name: `expiring-${Date.now()}`,
            expiresAt: farFuture,
        });
        expect(new Date(longLived.expiresAt as string).getTime(), 'expiresAt recorded').toBe(
            new Date(farFuture).getTime(),
        );
        const listed = (await listKeys(request, owner.access_token)).find(
            (k) => k.id === longLived.id,
        );
        expect(listed?.expiresAt, 'expiry surfaced in list').toBeTruthy();
        expect(new Date(listed!.expiresAt as string).getTime()).toBe(new Date(farFuture).getTime());

        // Now prove ENFORCEMENT (not just recording): a key that expires in ~3s
        // authenticates before its deadline and is rejected after it lapses.
        const soon = new Date(Date.now() + 3000).toISOString();
        const shortLived = await createKey(request, owner.access_token, {
            name: `short-${Date.now()}`,
            expiresAt: soon,
        });

        const beforeExpiry = await request.get(PROFILE_FRESH, {
            headers: { 'x-api-key': shortLived.key },
        });
        expect(beforeExpiry.status(), 'key valid before its expiresAt').toBe(200);
        expect((await beforeExpiry.json()).email).toBe(owner.user.email);

        // Poll past the deadline. validateKey() rejects rows whose expiresAt < now,
        // so once the wall clock crosses `soon` the very next request must 401.
        await expect
            .poll(
                async () => {
                    const r = await request.get(PROFILE_FRESH, {
                        headers: { 'x-api-key': shortLived.key },
                    });
                    return r.status();
                },
                {
                    message: 'expired key must be rejected after its expiresAt lapses',
                    timeout: 20_000,
                    intervals: [500, 750, 1_000, 1_500],
                },
            )
            .toBe(401);

        // The expired key is rejected with the canonical message even though it
        // physically remains in the table (expired rows are not auto-purged).
        const afterExpiry = await request.get(PROFILE_FRESH, {
            headers: { 'x-api-key': shortLived.key },
        });
        expect(afterExpiry.status()).toBe(401);
        expect((await afterExpiry.json()).message).toMatch(/invalid or expired api key/i);
    });

    test('cross-user isolation: a key maps only to its owner; lists and revocation are owner-scoped', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        expect(alice.user.id).not.toBe(bob.user.id);

        const aliceKey = await createKey(request, alice.access_token, {
            name: `alice-${Date.now()}`,
        });
        const bobKey = await createKey(request, bob.access_token, { name: `bob-${Date.now()}` });

        // 1. Alice's secret ALWAYS resolves to Alice — never Bob — no matter the slot used.
        for (const headers of [{ 'x-api-key': aliceKey.key }, authedHeaders(aliceKey.key)]) {
            const res = await request.get(PROFILE_FRESH, { headers });
            expect(res.status()).toBe(200);
            const who = await res.json();
            expect(who.email, "Alice's key authenticates as Alice").toBe(alice.user.email);
            expect(who.email).not.toBe(bob.user.email);
        }
        // And symmetrically Bob's key authenticates as Bob.
        const bobWho = await request.get(PROFILE_FRESH, { headers: { 'x-api-key': bobKey.key } });
        expect((await bobWho.json()).email).toBe(bob.user.email);

        // 2. Each user's list is strictly owner-scoped — no cross-tenant bleed.
        const aliceList = await listKeys(request, alice.access_token);
        const bobList = await listKeys(request, bob.access_token);
        expect(
            aliceList.some((k) => k.id === aliceKey.id),
            "Alice sees Alice's key",
        ).toBe(true);
        expect(
            aliceList.some((k) => k.id === bobKey.id),
            "Alice cannot see Bob's key",
        ).toBe(false);
        expect(
            bobList.some((k) => k.id === bobKey.id),
            "Bob sees Bob's key",
        ).toBe(true);
        expect(
            bobList.some((k) => k.id === aliceKey.id),
            "Bob cannot see Alice's key",
        ).toBe(false);

        // 3. Bob cannot revoke Alice's key — delete is scoped by (id, userId) → 404,
        //    and Alice's key keeps working afterward (the failed revoke had no effect).
        const crossRevoke = await request.delete(`${KEYS}/${aliceKey.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(crossRevoke.status(), "Bob cannot revoke Alice's key").toBe(404);

        const stillWorks = await request.get(PROFILE_FRESH, {
            headers: { 'x-api-key': aliceKey.key },
        });
        expect(stillWorks.status(), "Alice's key survives Bob's failed revoke").toBe(200);
        expect((await stillWorks.json()).email).toBe(alice.user.email);

        // 4. The legitimate owner CAN revoke, and that revocation is immediate + final.
        const ownRevoke = await request.delete(`${KEYS}/${aliceKey.id}`, {
            headers: authedHeaders(alice.access_token),
        });
        expect(ownRevoke.status(), 'owner revoke succeeds').toBe(200);
        const goneNow = await request.get(PROFILE_FRESH, {
            headers: { 'x-api-key': aliceKey.key },
        });
        expect(goneNow.status(), "Alice's revoked key is rejected").toBe(401);

        // Bob is entirely unaffected by Alice's revocation.
        const bobUnaffected = await request.get(PROFILE_FRESH, {
            headers: { 'x-api-key': bobKey.key },
        });
        expect(bobUnaffected.status(), "Bob's key unaffected by Alice's revoke").toBe(200);
    });
});
