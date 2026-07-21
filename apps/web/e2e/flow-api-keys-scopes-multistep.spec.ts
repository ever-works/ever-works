import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-api-keys-scopes-multistep.spec.ts
 *
 * THEME: the MULTI-STEP operational lifecycle of the `ew_live_…` API key — manual
 * ROTATION (there is no rotate endpoint, so rotation = create-new + revoke-old with a
 * zero-downtime overlap), the ONE-TIME-only plaintext (unrecoverable after create),
 * the exact REDACTED list shape, SELF- and CROSS-key revocation performed *through* a
 * key's own owner-wide authority, selective `lastUsedAt` stamping, `createdAt` DESC
 * list ordering, and the secret-MUTATION rejection matrix (exact SHA-256 match is
 * required; the non-secret prefix cannot authenticate).
 *
 * WHY "scopes" in the filename: the assigned theme framed OAuth-style capability
 * scopes, but this key type implements NO capability model (proved exhaustively in the
 * sibling scope-enforcement spec). The faithful "scope" surface here is therefore the
 * TEMPORAL + OWNERSHIP grant: a key spans its owner's full rights until revoked, and the
 * only ways to narrow the grant are revocation (self, cross-key, or owner-session) and
 * expiry. This file pins the multi-step mechanics of those, NOT a fictional 403.
 *
 * NON-DUPLICATION — already pinned by siblings, intentionally NOT repeated here:
 *   flow-api-keys-lifecycle.spec.ts       create-once secret + masked list + revoke-immediate
 *                                         + expiry ENFORCEMENT (poll past deadline) + A/B isolation
 *   flow-api-keys-lifecycle-deep.spec.ts  MAX_KEYS_PER_USER=10 quota + name boundaries (100/101/
 *                                         non-string/empty) + duplicate names + future-expiry echo
 *                                         + userId mass-assign + fresh lastUsedAt:null + anon 401 +
 *                                         revoke 404-hardening + full-owner-rights (read + MINT)
 *   flow-api-key-scope-enforcement.spec.ts  no scope model (scope fields 400) + cross-owner cannot
 *                                         escalate + revoked→401 both slots + past-expiry reject +
 *                                         x-api-key vs Bearer PREFIX-gated precedence + no PATCH/PUT
 *
 * THIS FILE's NEW angles (probe-verified live 2026-07-21 + cross-checked vs source):
 *   apps/api/src/auth/controllers/api-keys.controller.ts  (only POST '', GET '', DELETE ':id')
 *   apps/api/src/auth/services/api-key.service.ts         (SHA-256 hash, one-time plaintext)
 *   packages/agent/src/database/repositories/api-key.repository.ts
 *       findByUserId select = [id,name,prefix,expiresAt,lastUsedAt,isActive,createdAt], order createdAt DESC
 *
 * PROBED CONTRACTS (exact, live):
 *   GET    /api/auth/api-keys/:id                 → 404 (NO per-key detail route exists — via Bearer
 *                                                    AND via x-api-key; the plaintext is unrecoverable).
 *   POST   /api/auth/api-keys/:id/rotate          → 404 (NO dedicated rotate endpoint; rotation is a
 *                                                    client-side create-new + revoke-old dance).
 *   GET    /api/auth/api-keys  (list)             → row keys EXACTLY
 *                                                    {id,name,prefix,expiresAt,lastUsedAt,isActive,createdAt}
 *                                                    — NO userId / hashedKey / key / tenantId / organizationId;
 *                                                    ordered createdAt DESC (newest first).
 *   Secret-mutation matrix (x-api-key), ALL → 401:
 *     • UPPERCASED key                            (hash mismatch)
 *     • TRUNCATED key (last char dropped)         (hash mismatch)
 *     • FLIPPED last hex char                     (hash mismatch)
 *     • PREFIX-only (12-char "ew_live_XXXX")      (non-secret fingerprint cannot auth)
 *     • HEX-only (64 hex, no ew_live_ prefix)     (un-prefixed ⇒ ignored ⇒ falls through ⇒ no session)
 *     • EMPTY x-api-key                           (falsy ⇒ ignored ⇒ provider path ⇒ no session)
 *   A key wields FULL owner authority on the management surface itself:
 *     • x-api-key can REVOKE another of the owner's keys (cross-key) → 200; that key then 401s.
 *     • x-api-key can REVOKE ITSELF → 200; the same key then 401s everywhere (it deleted its own auth).
 *     • x-api-key DELETE of a garbage / nonexistent id → 404 (owner-scoped, never 500).
 *   Selective stamping: only the key actually USED gets a non-null lastUsedAt (~now); peers stay null.
 *   Mass-assignment: hashedKey / isActive / id / prefix / lastUsedAt extra fields → 400 "property X
 *                    should not exist" (cannot pre-seed a security column at issue time).
 *   Create validation: {} → 400 (name required, 3 messages); no body → 400; boolean name → 400
 *                    "must be a string"; whitespace-only name "   " → 201 (IsNotEmpty passes whitespace).
 *
 * Isolation: every test registers a FRESH registerUserViaAPI() user (never the shared seeded user);
 * unique suffixes come from a per-test counter, never a module-scope clock. Defensive throughout:
 * failOnStatusCode:false + status SETS + feature-presence skip so nothing asserts a fictional
 * contract if the api-keys surface is git-gated out of a given driver build.
 */

const KEYS = `${API_BASE}/api/auth/api-keys`;
const PROFILE_FRESH = `${API_BASE}/api/auth/profile/fresh`;

let counter = 0;
const uniq = (label: string) =>
    `${label}-${++counter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface CreatedKey {
    id: string;
    name: string;
    key: string;
    prefix: string;
    expiresAt: string | null;
    createdAt: string;
}

/** Is the api-keys surface present in this driver build (not 404/501)? */
async function keysFeaturePresent(request: APIRequestContext, token: string): Promise<boolean> {
    const res = await request.get(KEYS, { headers: authedHeaders(token), failOnStatusCode: false });
    return res.status() !== 404 && res.status() !== 501;
}

/** Create a key with explicit credentials (Bearer token OR x-api-key headers). */
async function createKeyWith(
    request: APIRequestContext,
    headers: Record<string, string>,
    name: string,
    expiresAt?: string,
): Promise<{ status: number; key: CreatedKey | null; raw: any }> {
    const res = await request.post(KEYS, {
        headers: { ...headers, 'content-type': 'application/json' },
        data: expiresAt ? { name, expiresAt } : { name },
        failOnStatusCode: false,
    });
    const status = res.status();
    let raw: any = null;
    try {
        raw = await res.json();
    } catch {
        /* non-JSON */
    }
    return { status, key: status === 201 && raw?.key ? (raw as CreatedKey) : null, raw };
}

/** Convenience: create via the owner's Bearer session and assert 201. */
async function mint(
    request: APIRequestContext,
    token: string,
    name: string,
    expiresAt?: string,
): Promise<CreatedKey> {
    const r = await createKeyWith(request, authedHeaders(token), name, expiresAt);
    expect(r.status, `mint '${name}' should be 201; got ${r.status} ${JSON.stringify(r.raw)}`).toBe(
        201,
    );
    return r.key!;
}

async function listKeys(request: APIRequestContext, token: string): Promise<any[]> {
    const res = await request.get(KEYS, { headers: authedHeaders(token), failOnStatusCode: false });
    expect(res.status(), 'owner list is 200').toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows), 'list endpoint returns an array').toBe(true);
    return rows;
}

async function whoAmI(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
    const res = await request.get(PROFILE_FRESH, { headers, failOnStatusCode: false });
    let body: any = null;
    try {
        body = await res.json();
    } catch {
        /* non-JSON */
    }
    return { status: res.status(), body };
}

test.describe('API keys — rotation, redaction shape, self/cross-key revoke & secret-mutation gaps', () => {
    // ---------------------------------------------------------------------------------------------
    // 1. One-time plaintext is UNRECOVERABLE: no per-key detail route, and no later read leaks it.
    // ---------------------------------------------------------------------------------------------
    test('the plaintext secret is one-time-only: there is NO GET /:id detail route (404 via Bearer AND x-api-key) and no later read re-exposes it', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent (404/501) in this driver');
            return;
        }
        const created = await mint(request, owner.access_token, uniq('once'));

        // (a) No per-key detail endpoint at all — GET /:id is not a route, so it 404s regardless of
        //     which credential authenticates. The controller exposes ONLY POST '', GET '', DELETE ':id'.
        const detailBearer = await request.get(`${KEYS}/${created.id}`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect(
            detailBearer.status(),
            `GET /:id via Bearer → 404; got ${detailBearer.status()}`,
        ).toBe(404);
        const detailKey = await request.get(`${KEYS}/${created.id}`, {
            headers: { 'x-api-key': created.key },
            failOnStatusCode: false,
        });
        expect(detailKey.status(), `GET /:id via x-api-key → 404; got ${detailKey.status()}`).toBe(
            404,
        );

        // (b) The masked list never re-surfaces the plaintext; only the 12-char prefix fingerprint.
        const rows = await listKeys(request, owner.access_token);
        expect(JSON.stringify(rows).includes(created.key), 'plaintext absent from list').toBe(
            false,
        );
        const row = rows.find((r) => r.id === created.id);
        expect(row, 'created key appears in owner list').toBeTruthy();
        expect(row.prefix, 'only the non-secret prefix survives').toBe(created.prefix);

        // (c) Re-creating with the SAME label does NOT hand back the lost secret — a fresh random
        //     32-byte secret is minted, proving the plaintext genuinely cannot be recovered.
        const again = await mint(request, owner.access_token, created.name);
        expect(again.name, 'same label reused').toBe(created.name);
        expect(again.key, 'recreate yields a DIFFERENT secret (no recovery)').not.toBe(created.key);
        expect(again.prefix, 'and a different prefix fingerprint').not.toBe(created.prefix);
    });

    // ---------------------------------------------------------------------------------------------
    // 2. No dedicated rotate endpoint — rotation is a client-side dance, never a server route.
    // ---------------------------------------------------------------------------------------------
    test('there is NO dedicated rotate endpoint: POST /:id/rotate and POST /rotate both 404 (via Bearer and x-api-key)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const created = await mint(request, owner.access_token, uniq('norotate'));

        const rotateProbes: Array<{ label: string; url: string; headers: Record<string, string> }> =
            [
                {
                    label: '/:id/rotate Bearer',
                    url: `${KEYS}/${created.id}/rotate`,
                    headers: authedHeaders(owner.access_token),
                },
                {
                    label: '/:id/rotate x-api-key',
                    url: `${KEYS}/${created.id}/rotate`,
                    headers: { 'x-api-key': created.key },
                },
                {
                    label: '/rotate Bearer',
                    url: `${KEYS}/rotate`,
                    headers: authedHeaders(owner.access_token),
                },
            ];
        for (const { label, url, headers } of rotateProbes) {
            const res = await request.post(url, {
                headers: { ...headers, 'content-type': 'application/json' },
                data: {},
                failOnStatusCode: false,
            });
            expect(
                [404, 405],
                `${label} must not be a live rotate route; got ${res.status()}`,
            ).toContain(res.status());
            expect(res.status(), `${label} is never a 500`).not.toBe(500);
        }
    });

    // ---------------------------------------------------------------------------------------------
    // 3. Manual zero-downtime rotation: create-new, overlap, revoke-old — ownership preserved.
    // ---------------------------------------------------------------------------------------------
    test('manual zero-downtime rotation: mint a NEW key that overlaps the OLD one (both valid), then revoke the old — old 401s, new keeps working, same owner throughout', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }

        // OLD key in service and proven working.
        const oldKey = await mint(request, owner.access_token, uniq('rotate-old'));
        const oldUse = await whoAmI(request, { 'x-api-key': oldKey.key });
        expect(oldUse.status, 'old key authenticates before rotation').toBe(200);
        expect(oldUse.body.email).toBe(owner.user.email);

        // NEW key minted alongside — distinct secret + distinct prefix, resolves to the SAME owner.
        const newKey = await mint(request, owner.access_token, uniq('rotate-new'));
        expect(newKey.key, 'rotation mints a fresh secret').not.toBe(oldKey.key);
        expect(newKey.prefix, 'and a fresh prefix fingerprint').not.toBe(oldKey.prefix);

        // OVERLAP WINDOW: both keys authenticate simultaneously (this is what makes rotation
        // zero-downtime — the client can cut over before retiring the old credential).
        const bothOld = await whoAmI(request, { 'x-api-key': oldKey.key });
        const bothNew = await whoAmI(request, { 'x-api-key': newKey.key });
        expect(bothOld.status, 'old still valid during overlap').toBe(200);
        expect(bothNew.status, 'new valid during overlap').toBe(200);
        expect(bothNew.body.id, 'new key resolves to the same owner id').toBe(owner.user.id);
        expect(bothOld.body.id).toBe(bothNew.body.id);

        // RETIRE the old key via the owner session.
        const revoke = await request.delete(`${KEYS}/${oldKey.id}`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect([200, 204], `retire old key; got ${revoke.status()}`).toContain(revoke.status());

        // Post-cutover: old is dead, new is alive, and only the new key remains masked in the list.
        const afterOld = await whoAmI(request, { 'x-api-key': oldKey.key });
        expect(afterOld.status, 'retired key is rejected immediately').toBe(401);
        expect(JSON.stringify(afterOld.body ?? {})).toMatch(/invalid or expired api key/i);

        const afterNew = await whoAmI(request, { 'x-api-key': newKey.key });
        expect(afterNew.status, 'rotated-in key keeps working').toBe(200);
        expect(afterNew.body.email, 'still the same owner after rotation').toBe(owner.user.email);

        const rows = await listKeys(request, owner.access_token);
        expect(
            rows.some((r) => r.id === oldKey.id),
            'retired key dropped from list',
        ).toBe(false);
        expect(
            rows.some((r) => r.id === newKey.id),
            'rotated-in key present in list',
        ).toBe(true);
        expect(JSON.stringify(rows).includes(newKey.key), 'new secret never leaks into list').toBe(
            false,
        );
    });

    // ---------------------------------------------------------------------------------------------
    // 4. Cross-key revocation: one key wields owner-wide authority to revoke ANOTHER of the owner's.
    // ---------------------------------------------------------------------------------------------
    test('a key carries owner-wide authority on the management surface: key B can REVOKE key A via x-api-key; A then 401s while B survives', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const keyA = await mint(request, owner.access_token, uniq('cross-a'));
        const keyB = await mint(request, owner.access_token, uniq('cross-b'));

        // Both authenticate up front.
        expect((await whoAmI(request, { 'x-api-key': keyA.key })).status).toBe(200);
        expect((await whoAmI(request, { 'x-api-key': keyB.key })).status).toBe(200);

        // B (not the Bearer session) deletes A's row — the key auth resolves to the owner, and the
        // owner may delete any of their own keys, so this is a legitimate owner-scoped revoke.
        const del = await request.delete(`${KEYS}/${keyA.id}`, {
            headers: { 'x-api-key': keyB.key },
            failOnStatusCode: false,
        });
        expect(del.status(), `B revokes A via x-api-key → 200; got ${del.status()}`).toBe(200);
        expect(JSON.stringify(await del.json().catch(() => ({}))), 'revoke message').toMatch(
            /revoked/i,
        );

        // A is dead, B keeps working.
        expect((await whoAmI(request, { 'x-api-key': keyA.key })).status, 'A revoked').toBe(401);
        expect((await whoAmI(request, { 'x-api-key': keyB.key })).status, 'B survives').toBe(200);

        // A second revoke of the now-gone A is the no-op 404 (deleteByIdAndUserId returns false).
        const again = await request.delete(`${KEYS}/${keyA.id}`, {
            headers: { 'x-api-key': keyB.key },
            failOnStatusCode: false,
        });
        expect(again.status(), 'second revoke of A → 404').toBe(404);

        // A truly gone from the owner list; B still there.
        const rows = await listKeys(request, owner.access_token);
        expect(rows.some((r) => r.id === keyA.id)).toBe(false);
        expect(rows.some((r) => r.id === keyB.id)).toBe(true);
    });

    // ---------------------------------------------------------------------------------------------
    // 5. Self-revocation: a key deletes its own row and immediately loses its own auth.
    // ---------------------------------------------------------------------------------------------
    test('self-revocation: a key can DELETE its own row via x-api-key (200), after which the very same key 401s everywhere', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const self = await mint(request, owner.access_token, uniq('selfkill'));
        expect((await whoAmI(request, { 'x-api-key': self.key })).status, 'valid before').toBe(200);

        // The key authenticates the DELETE of its OWN id, then it has revoked its own credential.
        const del = await request.delete(`${KEYS}/${self.id}`, {
            headers: { 'x-api-key': self.key },
            failOnStatusCode: false,
        });
        expect(del.status(), `self-revoke via x-api-key → 200; got ${del.status()}`).toBe(200);

        // Now the same secret is inert on every surface.
        expect((await whoAmI(request, { 'x-api-key': self.key })).status, 'profile 401').toBe(401);
        const listAfter = await request.get(KEYS, {
            headers: { 'x-api-key': self.key },
            failOnStatusCode: false,
        });
        expect(listAfter.status(), 'management list also 401 for the self-revoked key').toBe(401);

        // But the owner's Bearer session is unaffected and shows the key gone.
        const rows = await listKeys(request, owner.access_token);
        expect(
            rows.some((r) => r.id === self.id),
            'self-revoked key dropped from owner list',
        ).toBe(false);
    });

    // ---------------------------------------------------------------------------------------------
    // 6. List ordering is createdAt DESC (newest first).
    // ---------------------------------------------------------------------------------------------
    test('the list is ordered createdAt DESC: three sequentially-minted keys come back newest-first', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        // Space the creates so createdAt (second-resolution) differs deterministically.
        const first = await mint(request, owner.access_token, uniq('order-1'));
        await new Promise((r) => setTimeout(r, 1_100));
        const second = await mint(request, owner.access_token, uniq('order-2'));
        await new Promise((r) => setTimeout(r, 1_100));
        const third = await mint(request, owner.access_token, uniq('order-3'));

        const rows = await listKeys(request, owner.access_token);
        // Restrict to OUR three ids (robust vs any other rows / global counts).
        const mineInListOrder = rows
            .map((r) => r.id)
            .filter((id) => [first.id, second.id, third.id].includes(id));
        expect(mineInListOrder, 'all three of our keys are present').toHaveLength(3);
        expect(mineInListOrder, 'newest-first: third, second, first').toEqual([
            third.id,
            second.id,
            first.id,
        ]);

        // And the createdAt timestamps are monotonically non-increasing down the returned list.
        const times = rows
            .filter((r) => [first.id, second.id, third.id].includes(r.id))
            .map((r) => new Date(r.createdAt).getTime());
        expect(times[0] >= times[1] && times[1] >= times[2], 'createdAt DESC holds').toBe(true);
    });

    // ---------------------------------------------------------------------------------------------
    // 7. Exact redacted list-row shape (repository explicit `select`).
    // ---------------------------------------------------------------------------------------------
    test('list rows carry EXACTLY {id,name,prefix,expiresAt,lastUsedAt,isActive,createdAt} — no userId/hashedKey/key/tenantId/organizationId', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const created = await mint(request, owner.access_token, uniq('shape'));
        const rows = await listKeys(request, owner.access_token);
        const row = rows.find((r) => r.id === created.id);
        expect(row, 'created key present').toBeTruthy();

        // Exact key set — the repository `select` is authoritative (Tier-A scope FKs are NOT selected).
        expect(Object.keys(row).sort()).toEqual([
            'createdAt',
            'expiresAt',
            'id',
            'isActive',
            'lastUsedAt',
            'name',
            'prefix',
        ]);
        // Hard redaction guards (the security-critical omissions).
        for (const forbidden of [
            'userId',
            'hashedKey',
            'key',
            'tenantId',
            'organizationId',
            'user',
        ]) {
            expect(row, `list row must not leak ${forbidden}`).not.toHaveProperty(forbidden);
        }
        // Positive field-type sanity for a fresh, never-used, non-expiring key.
        expect(row.isActive).toBe(true);
        expect(row.expiresAt).toBeNull();
        expect(row.lastUsedAt).toBeNull();
        expect(row.prefix).toBe(created.key.slice(0, 12));
    });

    // ---------------------------------------------------------------------------------------------
    // 8. Selective lastUsedAt stamping — only the key actually used advances.
    // ---------------------------------------------------------------------------------------------
    test('lastUsedAt is stamped SELECTIVELY: using one key advances only that row (~now); the untouched sibling keys stay lastUsedAt:null', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const used = await mint(request, owner.access_token, uniq('used'));
        const idleA = await mint(request, owner.access_token, uniq('idle-a'));
        const idleB = await mint(request, owner.access_token, uniq('idle-b'));

        const t0 = Date.now();
        // Authenticate with ONLY `used` (twice, to be sure the fire-and-forget write lands).
        expect((await whoAmI(request, { 'x-api-key': used.key })).status).toBe(200);
        expect((await whoAmI(request, { 'x-api-key': used.key })).status).toBe(200);

        // Poll until the fire-and-forget lastUsedAt write is visible for the used key.
        await expect
            .poll(
                async () => {
                    const rows = await listKeys(request, owner.access_token);
                    return rows.find((r) => r.id === used.id)?.lastUsedAt ?? null;
                },
                {
                    message: 'used key stamps lastUsedAt',
                    timeout: 10_000,
                    intervals: [300, 500, 800],
                },
            )
            .not.toBeNull();

        const rows = await listKeys(request, owner.access_token);
        const usedRow = rows.find((r) => r.id === used.id);
        const idleARow = rows.find((r) => r.id === idleA.id);
        const idleBRow = rows.find((r) => r.id === idleB.id);

        // The used row's stamp is a plausible "roughly now" timestamp.
        const stamp = new Date(usedRow.lastUsedAt).getTime();
        expect(Number.isNaN(stamp), 'lastUsedAt is a valid time').toBe(false);
        expect(stamp, 'lastUsedAt is not before we started using it').toBeGreaterThanOrEqual(
            t0 - 5_000,
        );
        expect(stamp, 'lastUsedAt is not in the far future').toBeLessThanOrEqual(
            Date.now() + 5_000,
        );

        // The two never-used siblings remain null — proving the stamp is per-key, not global.
        expect(idleARow.lastUsedAt, 'untouched key A stays null').toBeNull();
        expect(idleBRow.lastUsedAt, 'untouched key B stays null').toBeNull();
    });

    // ---------------------------------------------------------------------------------------------
    // 9. Secret-mutation rejection matrix — exact hash match is required; the prefix cannot auth.
    // ---------------------------------------------------------------------------------------------
    test('the SHA-256 secret must match byte-for-byte: uppercased, truncated, flipped-char, prefix-only, hex-only-no-prefix and empty x-api-key all 401 (never 500)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const created = await mint(request, owner.access_token, uniq('mutate'));
        const secret = created.key;

        // Sanity: the pristine secret authenticates (so any 401 below is the mutation, not a bad key).
        expect((await whoAmI(request, { 'x-api-key': secret })).status, 'pristine key works').toBe(
            200,
        );

        const lastHex = secret.slice(-1);
        const flipped = secret.slice(0, -1) + (lastHex === '0' ? '1' : '0');
        const mutations: Array<[string, string]> = [
            ['uppercased', secret.toUpperCase()],
            ['truncated (drop last char)', secret.slice(0, -1)],
            ['flipped last hex char', flipped],
            ['prefix-only (12-char fingerprint)', created.prefix],
            ['hex-only (no ew_live_ prefix)', secret.replace(/^ew_live_/, '')],
            ['empty', ''],
        ];

        for (const [label, value] of mutations) {
            const res = await whoAmI(request, { 'x-api-key': value });
            expect(res.status, `${label} x-api-key must be rejected; got ${res.status}`).toBe(401);
            expect(res.status, `${label} must never 500`).not.toBe(500);
        }
    });

    // ---------------------------------------------------------------------------------------------
    // 10. Mass-assignment guard on security-sensitive columns at create.
    // ---------------------------------------------------------------------------------------------
    test('security columns cannot be pre-seeded at create: hashedKey / isActive / id / prefix / lastUsedAt are each mass-assignment-rejected (400 "should not exist")', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const before = (await listKeys(request, owner.access_token)).length;

        for (const field of ['hashedKey', 'isActive', 'id', 'prefix', 'lastUsedAt'] as const) {
            const body: Record<string, unknown> = { name: uniq('ma'), [field]: 'x' };
            const res = await request.post(KEYS, {
                headers: {
                    ...authedHeaders(owner.access_token),
                    'content-type': 'application/json',
                },
                data: body,
                failOnStatusCode: false,
            });
            expect(res.status(), `smuggling '${field}' must 400; got ${res.status()}`).toBe(400);
            expect(JSON.stringify(await res.json().catch(() => ({})))).toMatch(
                new RegExp(`property ${field} should not exist|should not exist`, 'i'),
            );
        }

        // None of the rejected requests created a row (forbidNonWhitelisted rejects the WHOLE body).
        const after = await listKeys(request, owner.access_token);
        expect(after.length, 'no key was created by any rejected mass-assignment attempt').toBe(
            before,
        );
    });

    // ---------------------------------------------------------------------------------------------
    // 11. Create-body validation edges distinct from the sibling boundary spec.
    // ---------------------------------------------------------------------------------------------
    test('create-body validation edges: {} → 400 (name required), no body → 400, boolean name → 400 "must be a string", but a whitespace-only name is ACCEPTED (IsNotEmpty passes whitespace)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }

        // Empty object → name required (the DTO reports all three name violations).
        const emptyObj = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: {},
            failOnStatusCode: false,
        });
        expect(emptyObj.status(), 'empty object → 400').toBe(400);
        expect(JSON.stringify((await emptyObj.json()).message)).toMatch(
            /name should not be empty/i,
        );

        // No body at all → still 400 (name is required).
        const noBody = await request.post(KEYS, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect(noBody.status(), 'no body → 400').toBe(400);

        // Boolean name trips @IsString (distinct from the numeric case pinned by the sibling spec).
        const boolName = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: { name: true },
            failOnStatusCode: false,
        });
        expect(boolName.status(), 'boolean name → 400').toBe(400);
        expect(JSON.stringify((await boolName.json()).message)).toMatch(/name must be a string/i);

        // Whitespace-only name is NOT empty by @IsNotEmpty's definition → 201, stored verbatim.
        // (This is the meaningful distinction from the empty-string case: "   " length > 0.)
        const ws = await createKeyWith(request, authedHeaders(owner.access_token), '   ');
        expect(ws.status, `whitespace-only name accepted; got ${ws.status}`).toBe(201);
        expect(ws.key!.name, 'whitespace name stored verbatim').toBe('   ');
    });

    // ---------------------------------------------------------------------------------------------
    // 12. Key-auth identity parity with the owner's Bearer session.
    // ---------------------------------------------------------------------------------------------
    test('key auth resolves to the SAME identity as the owner Bearer session — via x-api-key AND via Bearer ew_live_ — never a different or partial user', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const created = await mint(request, owner.access_token, uniq('parity'));

        // Baseline: the owner's own Bearer session identity.
        const viaSession = await whoAmI(request, authedHeaders(owner.access_token));
        expect(viaSession.status, 'session profile 200').toBe(200);
        expect(viaSession.body.id).toBe(owner.user.id);
        expect(viaSession.body.email).toBe(owner.user.email);

        // The key must resolve to the identical id + email through BOTH header slots.
        const slots: Array<{ label: string; headers: Record<string, string> }> = [
            { label: 'x-api-key', headers: { 'x-api-key': created.key } },
            { label: 'Bearer ew_live_', headers: authedHeaders(created.key) },
        ];
        for (const { label, headers } of slots) {
            const viaKey = await whoAmI(request, headers);
            expect(viaKey.status, `${label} authenticates`).toBe(200);
            expect(viaKey.body.id, `${label} resolves to the SAME user id`).toBe(
                viaSession.body.id,
            );
            expect(viaKey.body.email, `${label} resolves to the SAME email`).toBe(
                viaSession.body.email,
            );
            expect(viaKey.body.isAnonymous, `${label} is not an anonymous principal`).toBe(false);
        }
    });

    // ---------------------------------------------------------------------------------------------
    // 13. Distinct, collision-free secrets & prefixes at scale.
    // ---------------------------------------------------------------------------------------------
    test('every minted key is cryptographically distinct: five keys yield five unique secrets AND five unique prefixes, each ew_live_+64hex with prefix = first 12 chars', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const keys: CreatedKey[] = [];
        for (let i = 0; i < 5; i++) {
            keys.push(await mint(request, owner.access_token, uniq(`scale-${i}`)));
        }

        for (const k of keys) {
            expect(k.key, 'secret is ew_live_ + 64 hex (72 chars)').toMatch(
                /^ew_live_[0-9a-f]{64}$/,
            );
            expect(k.key).toHaveLength(72);
            expect(k.prefix, 'prefix is the 12-char head of the secret').toBe(k.key.slice(0, 12));
            expect(k.prefix).toMatch(/^ew_live_[0-9a-f]{4}$/);
        }
        // Full distinctness — no secret or prefix collides across the batch.
        expect(new Set(keys.map((k) => k.key)).size, 'all secrets distinct').toBe(5);
        expect(new Set(keys.map((k) => k.prefix)).size, 'all prefixes distinct').toBe(5);
        expect(new Set(keys.map((k) => k.id)).size, 'all ids distinct').toBe(5);
    });

    // ---------------------------------------------------------------------------------------------
    // 14. Key-auth list parity: the list a key sees == the owner-session list, and is masked.
    // ---------------------------------------------------------------------------------------------
    test('a key can read the owner-scoped list and sees EXACTLY the same id set as the Bearer session — still masked (no secret in the key-auth response)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const a = await mint(request, owner.access_token, uniq('viewer-a'));
        const b = await mint(request, owner.access_token, uniq('viewer-b'));

        const sessionRows = await listKeys(request, owner.access_token);
        const viaKey = await request.get(KEYS, {
            headers: { 'x-api-key': a.key },
            failOnStatusCode: false,
        });
        expect(viaKey.status(), 'a key can read its owner list').toBe(200);
        const keyRows: any[] = await viaKey.json();

        const sessionIds = new Set(sessionRows.map((r) => r.id));
        const keyIds = new Set(keyRows.map((r) => r.id));
        for (const id of [a.id, b.id]) {
            expect(sessionIds.has(id), `session list contains ${id}`).toBe(true);
            expect(keyIds.has(id), `key-auth list contains ${id}`).toBe(true);
        }
        expect(keyIds.size, 'key-auth list id set matches session list id set').toBe(
            sessionIds.size,
        );

        // The key-auth list is masked exactly like the session list — never the raw secret.
        expect(
            JSON.stringify(keyRows).includes(a.key),
            'own secret absent from key-auth list',
        ).toBe(false);
        expect(JSON.stringify(keyRows).includes(b.key), 'sibling secret absent too').toBe(false);
    });

    // ---------------------------------------------------------------------------------------------
    // 15. A revoked key loses ALL surfaces, not just profile.
    // ---------------------------------------------------------------------------------------------
    test('revocation is total: a revoked key 401s on profile AND on the management list AND on create — the grant is gone everywhere at once', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const key = await mint(request, owner.access_token, uniq('total'));

        // Prove reach on all three surfaces BEFORE revoke.
        expect((await whoAmI(request, { 'x-api-key': key.key })).status, 'profile pre').toBe(200);
        const listPre = await request.get(KEYS, {
            headers: { 'x-api-key': key.key },
            failOnStatusCode: false,
        });
        expect(listPre.status(), 'list pre').toBe(200);
        const createPre = await createKeyWith(
            request,
            { 'x-api-key': key.key },
            uniq('total-child'),
        );
        expect(createPre.status, 'create pre').toBe(201);

        // Revoke via the owner session.
        const revoke = await request.delete(`${KEYS}/${key.id}`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect([200, 204]).toContain(revoke.status());

        // All three surfaces now 401 for the revoked key.
        expect((await whoAmI(request, { 'x-api-key': key.key })).status, 'profile post → 401').toBe(
            401,
        );
        const listPost = await request.get(KEYS, {
            headers: { 'x-api-key': key.key },
            failOnStatusCode: false,
        });
        expect(listPost.status(), 'list post → 401').toBe(401);
        const createPost = await createKeyWith(
            request,
            { 'x-api-key': key.key },
            uniq('total-orphan'),
        );
        expect(createPost.status, 'create post → 401').toBe(401);

        // The child key minted BEFORE revoke is independent and still works (revoke is per-row).
        const child = createPre.key!;
        expect(
            (await whoAmI(request, { 'x-api-key': child.key })).status,
            'pre-revoke child survives',
        ).toBe(200);
    });

    // ---------------------------------------------------------------------------------------------
    // 16. Owner-scoped DELETE through key auth is 404-hardened for bad ids (never 500).
    // ---------------------------------------------------------------------------------------------
    test('DELETE through x-api-key is 404-hardened: a non-UUID id and a well-formed-but-nonexistent UUID both 404 (never 500/400), and a real sibling id succeeds', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const actor = await mint(request, owner.access_token, uniq('actor'));
        const victim = await mint(request, owner.access_token, uniq('victim'));

        // Garbage id via key auth → 404 (bare @Param, no ParseUUIDPipe; row-miss → NotFound).
        const garbage = await request.delete(`${KEYS}/not-a-real-id`, {
            headers: { 'x-api-key': actor.key },
            failOnStatusCode: false,
        });
        expect(garbage.status(), `non-UUID id → 404; got ${garbage.status()}`).toBe(404);
        expect(garbage.status()).not.toBe(500);

        // Nonexistent UUID via key auth → identical 404.
        const ghost = await request.delete(`${KEYS}/22222222-2222-2222-2222-222222222222`, {
            headers: { 'x-api-key': actor.key },
            failOnStatusCode: false,
        });
        expect(ghost.status(), `nonexistent UUID → 404; got ${ghost.status()}`).toBe(404);
        expect(ghost.status()).not.toBe(500);

        // But a REAL owned id is deletable through the same key auth → 200, and the victim then 401s.
        const real = await request.delete(`${KEYS}/${victim.id}`, {
            headers: { 'x-api-key': actor.key },
            failOnStatusCode: false,
        });
        expect(real.status(), 'real owned id deletable via key auth → 200').toBe(200);
        expect((await whoAmI(request, { 'x-api-key': victim.key })).status, 'victim now 401').toBe(
            401,
        );
        expect((await whoAmI(request, { 'x-api-key': actor.key })).status, 'actor unaffected').toBe(
            200,
        );
    });

    // ---------------------------------------------------------------------------------------------
    // 17. Unicode / emoji label round-trips verbatim.
    // ---------------------------------------------------------------------------------------------
    test('a unicode/emoji label round-trips verbatim through create and the masked list (name is a free-form label, not a slug)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const label = `prod-key ${uniq('ci')} 🔑-café-Ω`;
        const created = await createKeyWith(request, authedHeaders(owner.access_token), label);
        expect(created.status, `unicode label accepted; got ${created.status}`).toBe(201);
        expect(created.key!.name, 'unicode label echoed verbatim on create').toBe(label);

        const rows = await listKeys(request, owner.access_token);
        const row = rows.find((r) => r.id === created.key!.id);
        expect(row, 'unicode-named key present in list').toBeTruthy();
        expect(row.name, 'unicode label preserved byte-for-byte in the list').toBe(label);
    });

    // ---------------------------------------------------------------------------------------------
    // 18. Timestamp fields are well-formed; a future expiresAt is reflected as active/not-yet-expired.
    // ---------------------------------------------------------------------------------------------
    test('timestamp fields are well-formed: createdAt is a recent ISO instant, an unset expiry is null, and a future-dated key lists isActive:true with the exact expiresAt echoed', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const t0 = Date.now();
        const plain = await mint(request, owner.access_token, uniq('ts-plain'));
        const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const dated = await mint(request, owner.access_token, uniq('ts-dated'), future);

        const rows = await listKeys(request, owner.access_token);
        const plainRow = rows.find((r) => r.id === plain.id);
        const datedRow = rows.find((r) => r.id === dated.id);
        expect(plainRow && datedRow, 'both keys listed').toBeTruthy();

        // createdAt is a valid, recent ISO instant (within a generous window of the request).
        const createdMs = new Date(plainRow.createdAt).getTime();
        expect(Number.isNaN(createdMs), 'createdAt parses').toBe(false);
        expect(createdMs).toBeGreaterThanOrEqual(t0 - 60_000);
        expect(createdMs).toBeLessThanOrEqual(Date.now() + 60_000);

        // Unset expiry → null; future expiry echoed exactly and still active (not yet lapsed).
        expect(plainRow.expiresAt, 'unset expiry → null').toBeNull();
        expect(new Date(datedRow.expiresAt).getTime(), 'future expiry echoed verbatim').toBe(
            new Date(future).getTime(),
        );
        expect(datedRow.isActive, 'a not-yet-expired key is active').toBe(true);
        expect(
            new Date(datedRow.expiresAt).getTime(),
            'future expiry is genuinely in the future',
        ).toBeGreaterThan(Date.now());
    });
});
