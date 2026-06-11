import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-api-keys-lifecycle-deep.spec.ts
 *
 * THEME: the DEEP edges of the `ew_live_…` API-key surface that the two existing
 * specs leave uncovered — the per-user QUOTA, name-validation boundaries, the
 * not-yet-used masked-list shape, anonymous lockout of the management endpoints,
 * 404-not-500 hardening of revoke, and the (load-bearing, easy-to-miss) fact that
 * an API key carries FULL owner rights — including minting MORE keys.
 *
 * NON-DUPLICATION — already pinned by siblings, intentionally NOT repeated here:
 *   flow-api-keys-lifecycle.spec.ts
 *     - create → raw secret returned ONCE (ew_live_+64hex, 72 chars) + masked list
 *     - the secret authenticates real requests via x-api-key AND Bearer (resolves to owner)
 *     - revoke → 401 on the very next request; second revoke → 404
 *     - server-side EXPIRY ENFORCEMENT (short-lived key works, then 401s after lapse)
 *     - cross-user isolation: A's key → A only; per-user lists; B can't revoke A's key (404)
 *     - past/malformed expiresAt rejected at create
 *   flow-api-key-scope-enforcement.spec.ts
 *     - no capability-scope model (scope/permission fields 400-rejected); plain key spans read+write
 *     - x-api-key vs Bearer PREFIX-gated precedence matrix; malformed/empty → 401, never 500
 *     - no PATCH/PUT update route (404); list never leaks key/hashedKey/scopes/permissions
 *
 * THIS FILE pins the GAPS (probe-verified against the live stack 2026-06-11 +
 * cross-checked against source):
 *   apps/api/src/auth/controllers/api-keys.controller.ts   (revoke → NotFoundException when !deleted)
 *   apps/api/src/auth/dto/api-key.dto.ts                   (name: IsString+IsNotEmpty+MaxLength(100))
 *   apps/api/src/auth/services/api-key.service.ts          (MAX_KEYS_PER_USER=10, active-row count)
 *
 * PROBED CONTRACTS (exact, live):
 *   POST /api/auth/api-keys
 *     • QUOTA: MAX_KEYS_PER_USER = 10. 11th create →
 *         400 { message:"Maximum of 10 API keys allowed per user", error:"Bad Request", statusCode:400 }
 *       The cap counts ACTIVE rows only; REVOKING a key frees a slot immediately → next create 201.
 *     • name > 100 chars →
 *         400 { message:["name must be shorter than or equal to 100 characters"], ... }
 *       exactly 100 chars → 201 (boundary inclusive).
 *     • non-string name (e.g. number) → 400 message INCLUDES "name must be a string".
 *     • empty-string name → 400 { message:["name should not be empty"], ... }.
 *     • DUPLICATE names are allowed — there is NO uniqueness constraint on the label; two keys may
 *       share a name (they are still distinct rows with distinct secrets/ids).
 *     • a future expiresAt is echoed VERBATIM (ISO-normalised) on the CREATE response itself, not
 *       just in the list.
 *     • MASS-ASSIGNMENT guard: an extra unknown field (e.g. userId) is rejected by the global
 *       ValidationPipe (forbidNonWhitelisted) → 400 { message:["property userId should not exist"] }
 *       — you cannot attribute a key to another user at create time.
 *     • a freshly-created, never-used key lists with lastUsedAt:null, isActive:true, expiresAt:null,
 *       prefix = key.slice(0,12); each key gets a DISTINCT prefix + secret.
 *   GET/POST/DELETE /api/auth/api-keys (ANON, no credential) →
 *         401 { message:"Unauthorized", statusCode:401 } on every verb.
 *   DELETE /api/auth/api-keys/:id
 *     • non-UUID id ("not-a-real-id")            → 404 { message:"API key not found", ... } (NOT 500/400 —
 *       :id is a bare @Param, no ParseUUIDPipe; service returns false → controller throws NotFound).
 *     • well-formed but nonexistent UUID         → 404 same body.
 *   FULL-OWNER-RIGHTS of a key (extractApiKey maps the key to its OWNER's user):
 *     • GET /api/auth/api-keys with x-api-key    → 200 (a key can READ its owner's key list)
 *     • POST /api/auth/api-keys with x-api-key   → 201 (a key can MINT another key for its owner);
 *       the new key authenticates independently, and BOTH count toward the owner's quota.
 *
 * Isolation: every test registers a FRESH registerUserViaAPI() user (never the shared seeded user);
 * unique suffixes come from a per-test counter, never a module-scope clock. Defensive throughout:
 * failOnStatusCode:false + status SETS + feature-presence skip so nothing asserts a fictional
 * contract if the api-keys surface is git-gated out of a given driver build.
 */

const KEYS = `${API_BASE}/api/auth/api-keys`;
const PROFILE_FRESH = `${API_BASE}/api/auth/profile/fresh`;

let counter = 0;
const uniq = (label: string) => `${label}-${++counter}-${Math.random().toString(36).slice(2, 7)}`;

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
): Promise<{ status: number; key: CreatedKey | null; raw: any }> {
    const res = await request.post(KEYS, {
        headers: { ...headers, 'content-type': 'application/json' },
        data: { name },
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

test.describe('API keys — deep quota, validation, anon lockout, and full-owner-rights gaps', () => {
    test('per-user quota: the 11th key is 400-rejected with the exact cap message; revoking a key frees a slot so the next create succeeds', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent (404/501) in this driver');
            return;
        }

        // Fill the user's quota to the MAX_KEYS_PER_USER = 10 ceiling.
        const ids: string[] = [];
        for (let i = 0; i < 10; i++) {
            const r = await createKeyWith(
                request,
                authedHeaders(owner.access_token),
                uniq('quota'),
            );
            expect(r.status, `create #${i + 1} should be 201; got ${r.status}`).toBe(201);
            ids.push(r.key!.id);
        }

        // The 11th create is rejected by the service cap — NOT the DTO — with the canonical message.
        const over = await createKeyWith(request, authedHeaders(owner.access_token), uniq('over'));
        expect(over.status, `11th create rejected; got ${over.status}`).toBe(400);
        expect(JSON.stringify(over.raw?.message ?? '')).toMatch(/maximum of \d+ api keys allowed/i);

        // The cap counts ACTIVE rows: revoke ONE active key and the freed slot is immediately usable.
        const revoke = await request.delete(`${KEYS}/${ids[0]}`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect([200, 204], `owner revoke frees a slot; got ${revoke.status()}`).toContain(
            revoke.status(),
        );

        const afterFree = await createKeyWith(
            request,
            authedHeaders(owner.access_token),
            uniq('afterfree'),
        );
        expect(
            afterFree.status,
            `create after revoke should succeed (slot freed); got ${afterFree.status}`,
        ).toBe(201);
        expect(afterFree.key, 'freed-slot create returns a fresh secret').toBeTruthy();

        // And we are back AT the ceiling — a further create is capped again (proves the count is live).
        const overAgain = await createKeyWith(
            request,
            authedHeaders(owner.access_token),
            uniq('overagain'),
        );
        expect(overAgain.status, `back at the cap → 400; got ${overAgain.status}`).toBe(400);
    });

    test('name validation boundaries: exactly 100 chars is accepted (201); 101 chars is 400; a non-string name reports "must be a string"', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }

        // Boundary INCLUSIVE: MaxLength(100) permits a 100-char name.
        const at100 = await createKeyWith(
            request,
            authedHeaders(owner.access_token),
            'a'.repeat(100),
        );
        expect(at100.status, `100-char name accepted; got ${at100.status}`).toBe(201);
        expect(at100.key!.name, 'name stored verbatim').toHaveLength(100);

        // One over the limit → 400 with the canonical class-validator message.
        const at101 = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: { name: 'a'.repeat(101) },
            failOnStatusCode: false,
        });
        expect(at101.status(), `101-char name rejected; got ${at101.status()}`).toBe(400);
        const at101Body = await at101.json();
        expect(JSON.stringify(at101Body.message)).toMatch(/shorter than or equal to 100/i);

        // A non-string name trips the @IsString() guard (in addition to MaxLength).
        const nonString = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: { name: 12345 },
            failOnStatusCode: false,
        });
        expect(nonString.status(), `numeric name rejected; got ${nonString.status()}`).toBe(400);
        expect(JSON.stringify((await nonString.json()).message)).toMatch(/name must be a string/i);
    });

    test('empty-string name is rejected ("should not be empty"); duplicate names are allowed (no label uniqueness — distinct rows/secrets)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }

        // Empty string trips @IsNotEmpty() (distinct from the >100 boundary and the non-string case).
        const empty = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: { name: '' },
            failOnStatusCode: false,
        });
        expect(empty.status(), `empty name rejected; got ${empty.status()}`).toBe(400);
        expect(JSON.stringify((await empty.json()).message)).toMatch(/should not be empty/i);

        // The label is NOT unique — two keys may share a name; they remain independent rows.
        const dupName = uniq('dupe');
        const a = await createKeyWith(request, authedHeaders(owner.access_token), dupName);
        const b = await createKeyWith(request, authedHeaders(owner.access_token), dupName);
        expect(a.status, `first dup-name create; got ${a.status}`).toBe(201);
        expect(b.status, `second dup-name create allowed; got ${b.status}`).toBe(201);
        expect(a.key!.id, 'duplicate-named keys are still distinct rows').not.toBe(b.key!.id);
        expect(a.key!.key, 'duplicate-named keys carry distinct secrets').not.toBe(b.key!.key);
        expect(a.key!.name).toBe(dupName);
        expect(b.key!.name).toBe(dupName);
    });

    test('a future expiresAt is echoed verbatim on the CREATE response; an unknown extra field (userId) is mass-assignment-rejected at create', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }

        // The create RESPONSE itself surfaces the requested expiresAt (ISO-normalised), proving the
        // value is round-tripped at issue time — not merely recorded for the list view.
        const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
        const created = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: { name: uniq('future'), expiresAt: future },
            failOnStatusCode: false,
        });
        expect(created.status(), `future-expiry create; got ${created.status()}`).toBe(201);
        const body = await created.json();
        expect(
            new Date(body.expiresAt as string).getTime(),
            'create response echoes the requested expiry',
        ).toBe(new Date(future).getTime());

        // MASS-ASSIGNMENT: forbidNonWhitelisted means a caller cannot smuggle a userId (or any other
        // field) into the create body to mint a key for someone else — the whole request is 400'd.
        const inject = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: { name: uniq('inject'), userId: '00000000-0000-0000-0000-000000000000' },
            failOnStatusCode: false,
        });
        expect(inject.status(), `userId injection rejected; got ${inject.status()}`).toBe(400);
        expect(JSON.stringify((await inject.json()).message)).toMatch(
            /property userId should not exist|should not exist/i,
        );
    });

    test('a freshly-created key lists with lastUsedAt:null and isActive:true BEFORE any use; distinct keys carry distinct, masked prefixes', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }

        // Create two keys but DO NOT authenticate with them — so lastUsedAt must stay null.
        const a = await createKeyWith(request, authedHeaders(owner.access_token), uniq('fresh-a'));
        const b = await createKeyWith(request, authedHeaders(owner.access_token), uniq('fresh-b'));
        expect(a.key && b.key, 'both keys created').toBeTruthy();

        // Distinct secrets AND distinct non-secret prefixes; the prefix is exactly the 12-char head.
        expect(a.key!.key).not.toBe(b.key!.key);
        expect(a.key!.prefix).not.toBe(b.key!.prefix);
        expect(a.key!.prefix, 'prefix is the 12-char fingerprint of the secret').toBe(
            a.key!.key.slice(0, 12),
        );
        expect(a.key!.prefix).toMatch(/^ew_live_[0-9a-f]{4}$/);

        const list = await request.get(KEYS, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect(list.status()).toBe(200);
        const rows: any[] = await list.json();
        const rowA = rows.find((r) => r.id === a.key!.id);
        expect(rowA, 'created-but-unused key appears in the owner list').toBeTruthy();
        // The freshly-minted, never-authenticated key has a NULL lastUsedAt — only USE advances it
        // (the sibling lifecycle spec proves the advance; here we pin the null starting state).
        expect(rowA.lastUsedAt, 'never-used key has lastUsedAt:null').toBeNull();
        expect(rowA.isActive, 'a non-expired key reports isActive:true').toBe(true);
        expect(rowA.expiresAt, 'no expiry requested → null in the list').toBeNull();
        // Masked list still never leaks the raw secret.
        expect(JSON.stringify(rows).includes(a.key!.key), 'raw secret absent from list').toBe(
            false,
        );
    });

    test('management endpoints reject anonymous callers: GET, POST and DELETE all 401 with no credential', async ({
        request,
    }) => {
        // No Authorization, no x-api-key. The whole controller sits behind the session guard.
        const anonGet = await request.get(KEYS, { failOnStatusCode: false });
        expect(anonGet.status(), 'anon GET list → 401').toBe(401);
        expect(JSON.stringify(await anonGet.json().catch(() => ({}))).toLowerCase()).toContain(
            'unauthorized',
        );

        const anonPost = await request.post(KEYS, {
            headers: { 'content-type': 'application/json' },
            data: { name: uniq('anon') },
            failOnStatusCode: false,
        });
        expect(anonPost.status(), 'anon POST create → 401').toBe(401);

        const anonDelete = await request.delete(`${KEYS}/00000000-0000-0000-0000-000000000000`, {
            failOnStatusCode: false,
        });
        expect(anonDelete.status(), 'anon DELETE → 401').toBe(401);
    });

    test('revoke is hardened to 404 (not 500/400) for a non-UUID id and for a well-formed-but-nonexistent UUID', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }

        // :id is a BARE @Param (no ParseUUIDPipe), so a garbage id is NOT a 400/500 — it simply finds
        // no matching (id,userId) row and the controller maps the false result to NotFoundException.
        const garbage = await request.delete(`${KEYS}/not-a-real-id`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect(garbage.status(), `non-UUID id → 404; got ${garbage.status()}`).toBe(404);
        expect(JSON.stringify(await garbage.json().catch(() => ({})))).toMatch(/not found/i);

        // A syntactically valid but nonexistent UUID behaves identically.
        const ghost = await request.delete(`${KEYS}/11111111-1111-1111-1111-111111111111`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect(ghost.status(), `nonexistent UUID → 404; got ${ghost.status()}`).toBe(404);

        // Neither bogus delete is a server error.
        expect(garbage.status()).not.toBe(500);
        expect(ghost.status()).not.toBe(500);
    });

    test('a key carries FULL owner rights: it can READ its owner key list AND MINT another key, and both keys count toward the same quota', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }

        // Mint a first key via the Bearer session.
        const first = await createKeyWith(
            request,
            authedHeaders(owner.access_token),
            uniq('parent'),
        );
        expect(first.key, `parent key created; got ${first.status}`).toBeTruthy();
        const parentSecret = first.key!.key;

        // 1. That key can READ its owner's key list (extractApiKey resolves it to the owner).
        const listViaKey = await request.get(KEYS, {
            headers: { 'x-api-key': parentSecret },
            failOnStatusCode: false,
        });
        expect(listViaKey.status(), 'a key can read its owner key list').toBe(200);
        const rowsViaKey: any[] = await listViaKey.json();
        expect(
            rowsViaKey.some((r) => r.id === first.key!.id),
            'the key sees itself in the owner-scoped list',
        ).toBe(true);

        // 2. That key can MINT another key (no privilege boundary between "session" and "key" for the
        //    owner) — the new secret authenticates independently and resolves to the SAME owner.
        const minted = await createKeyWith(request, { 'x-api-key': parentSecret }, uniq('minted'));
        expect(minted.status, `key minted another key; got ${minted.status}`).toBe(201);
        expect(minted.key, 'minted key returns its own fresh secret').toBeTruthy();
        expect(minted.key!.key).not.toBe(parentSecret);

        const mintedWho = await request.get(PROFILE_FRESH, {
            headers: { 'x-api-key': minted.key!.key },
            failOnStatusCode: false,
        });
        expect(mintedWho.status(), 'key-minted key authenticates').toBe(200);
        expect((await mintedWho.json()).email, 'minted key resolves to the same owner').toBe(
            owner.user.email,
        );

        // 3. Both keys count toward the owner's quota: the owner-scoped list now contains BOTH ids,
        //    confirming the minted key was attributed to the owner (not orphaned).
        const finalList = await request.get(KEYS, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        const finalRows: any[] = await finalList.json();
        expect(
            finalRows.some((r) => r.id === first.key!.id),
            'parent key present',
        ).toBe(true);
        expect(
            finalRows.some((r) => r.id === minted.key!.id),
            'key-minted key attributed to the same owner',
        ).toBe(true);
    });
});
