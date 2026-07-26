import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-api-keys-validation-authz-matrix.spec.ts
 *
 * THEME: an exhaustive VALIDATION + AUTHZ matrix for the `ew_live_…` API-key surface —
 * one assertion cluster per DTO field's rejection reason, the exact create-vs-list
 * response field-sets, the "no capability model" rejection matrix (the assigned
 * "scopes array enum" is a field that does NOT exist — it is 400-rejected), and the
 * precise auth envelopes / ordering (401-before-404) and the 404-NOT-403 existence-
 * hiding posture on cross-user access.
 *
 * Controller/DTO/service under test (read directly):
 *   apps/api/src/auth/controllers/api-keys.controller.ts  (POST '', GET '', DELETE ':id'; bare @Param)
 *   apps/api/src/auth/dto/api-key.dto.ts                  (name: IsString+IsNotEmpty+MaxLength(100);
 *                                                          expiresAt?: IsOptional+IsDateString)
 *   apps/api/src/auth/services/api-key.service.ts         (past-expiry check; MAX_KEYS_PER_USER=10)
 *   packages/agent/src/database/repositories/api-key.repository.ts (findByUserId explicit select)
 *   apps/api/src/main.ts ValidationPipe { whitelist, transform, forbidNonWhitelisted:true }
 *
 * NON-DUPLICATION — the following are already pinned by siblings and are deliberately NOT
 * re-asserted here (this file covers the DISTINCT validation/authz-envelope angles below them):
 *   api-keys.spec.ts / api-keys-lifecycle.spec.ts        shallow CRUD smoke
 *   flow-api-keys-lifecycle.spec.ts                      secret authenticates (x-api-key/Bearer),
 *                                                        expiry ENFORCEMENT (poll past deadline),
 *                                                        cross-user isolation of identity+lists+revoke
 *   flow-api-keys-lifecycle-deep.spec.ts                 quota-11th, name 100/101/number/empty,
 *                                                        duplicate names, userId mass-assign,
 *                                                        fresh lastUsedAt:null, anon 401, revoke
 *                                                        non-uuid/nonexistent 404, key-mints-key
 *   flow-api-key-scope-enforcement.spec.ts               scopes+permissions combined-400, plain key
 *                                                        spans read+write, revoked→401 both slots,
 *                                                        x-api-key/Bearer PREFIX-gated precedence,
 *                                                        no PATCH/PUT
 *   flow-api-keys-scopes-multistep.spec.ts               rotation, self/cross-key revoke, list DESC
 *                                                        order, exact LIST-row shape, selective
 *                                                        lastUsedAt, secret-mutation matrix, security-
 *                                                        COLUMN mass-assign, whitespace-name-201, unicode
 *
 * THIS FILE's NEW angles (probe-verified live 2026-07-21 against 127.0.0.1:3100 + source-checked):
 *   POST /api/auth/api-keys — CREATE RESPONSE shape is EXACTLY
 *       {id,name,key,prefix,expiresAt,createdAt}  — contains the one-time `key`, and OMITS
 *       lastUsedAt/isActive/userId/hashedKey/tenantId/organizationId (the LIST is the mirror:
 *       it drops `key`, adds lastUsedAt/isActive). key = "ew_live_"+64hex (72), prefix = key[0..12].
 *   expiresAt VALIDATION MATRIX (two DISTINCT rejection layers, one per branch):
 *       • wrong TYPE (number/boolean/object/array) or malformed/empty STRING
 *              → 400 message:["expiresAt must be a valid ISO 8601 date string"]   (class-validator)
 *       • well-formed but NON-FUTURE (past / now-1s)
 *              → 400 message:"Expiration date must be in the future"              (service layer)
 *       • ACCEPTED non-canonical forms normalized to a UTC instant:
 *              "2099-03-15"                    → "2099-03-15T00:00:00.000Z"
 *              "2099-06-01T10:00:00+02:00"     → "2099-06-01T08:00:00.000Z"
 *              year 9999 far-future            → 201
 *              null / omitted                  → 201 with expiresAt:null (IsOptional)
 *   "NO CAPABILITY MODEL" REJECTION MATRIX (forbidNonWhitelisted → 400 "property X should not exist",
 *       and the WHOLE body is rejected — the pipe does NOT silently strip; no row is created):
 *       • scope-shaped:   scopes(array|string), scope, permissions, role, roles, abilities, grant, access
 *       • temporal-alias: ttl, expiresIn, expiry, expires, maxAge   (expiresAt is the ONLY expiry input)
 *       • attribution:    userId, ownerId, tenantId, organizationId  (cannot scope a key to another
 *                                                                     principal / tenant / org at issue)
 *   VALIDATION ENVELOPES + ACCUMULATION:
 *       • {} → message is an ARRAY of 3 name validators; envelope {error:"Bad Request",statusCode:400}
 *       • a body mixing a bad name TYPE + a bad expiresAt + an unknown field accumulates ALL families
 *         into one message array (forbidNonWhitelisted entries FIRST), atomically rejected.
 *       • name non-primitive (array/object) → 400 "name must be a string".
 *       • non-object bodies ([] / JSON scalar) → 400, never 500.
 *   AUTH ENVELOPES + ORDERING:
 *       • anon → 401 {message:"Unauthorized",statusCode:401} EXACT (note: NO `error` field on 401).
 *       • the guard runs BEFORE existence: anon DELETE of a well-formed nonexistent uuid → 401
 *         (NOT 404); the SAME id with a valid Bearer → 404. Auth precedes the not-found check.
 *       • malformed Authorization (Bearer-no-token, Bearer-whitespace, wrong scheme, raw token) → 401.
 *   CROSS-USER: DELETE of another user's key → 404 (existence-HIDING; never 403) with EXACT body
 *       {message:"API key not found",error:"Not Found",statusCode:404}; proven no-op (victim still
 *       in owner's list, never in attacker's).
 *   REVOKE contract: owner DELETE → 200 EXACT {message:"API key revoked successfully"}; idempotent
 *       second DELETE → 404 EXACT envelope; row dropped from the owner list.
 *
 * Isolation: every test registers a FRESH registerUserViaAPI() user (never the shared seeded user);
 * unique suffixes come from a per-test counter, never a module-scope clock. Defensive throughout:
 * failOnStatusCode:false + status SETS + feature-presence skip so nothing asserts a fictional
 * contract if the api-keys surface is git-gated out of a given driver build. Row-count deltas are
 * measured only WITHIN a single freshly-registered, owner-scoped user (never a global count).
 */

const KEYS = `${API_BASE}/api/auth/api-keys`;

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

/** POST a raw create body with the owner's Bearer session; returns {status, body}. */
async function postKey(
    request: APIRequestContext,
    token: string,
    data: unknown,
): Promise<{ status: number; body: any }> {
    const res = await request.post(KEYS, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: data as any,
        failOnStatusCode: false,
    });
    let body: any = null;
    try {
        body = await res.json();
    } catch {
        /* non-JSON */
    }
    return { status: res.status(), body };
}

/** Create a valid key and assert 201; returns the CreatedKey. */
async function mint(
    request: APIRequestContext,
    token: string,
    name: string,
    expiresAt?: string,
): Promise<CreatedKey> {
    const r = await postKey(request, token, expiresAt ? { name, expiresAt } : { name });
    expect(
        r.status,
        `mint '${name}' should be 201; got ${r.status} ${JSON.stringify(r.body)}`,
    ).toBe(201);
    return r.body as CreatedKey;
}

async function listKeys(request: APIRequestContext, token: string): Promise<any[]> {
    const res = await request.get(KEYS, { headers: authedHeaders(token), failOnStatusCode: false });
    expect(res.status(), 'owner list is 200').toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows), 'list returns an array').toBe(true);
    return rows;
}

test.describe('API keys — validation + authz matrix (exhaustive per-field + envelopes)', () => {
    // =============================================================================================
    // A. CREATE RESPONSE CONTRACT — exact field-set, and how it mirrors the masked LIST row.
    // =============================================================================================
    test('the CREATE response carries EXACTLY {id,name,key,prefix,expiresAt,createdAt} — it exposes the one-time secret but OMITS lastUsedAt/isActive/userId/hashedKey', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent (404/501) in this driver');
            return;
        }
        const t0 = Date.now();
        const r = await postKey(request, owner.access_token, { name: uniq('shape') });
        expect(r.status, `create → 201; got ${r.status}`).toBe(201);
        const body = r.body as CreatedKey & Record<string, unknown>;

        // Exact field-set: the create response is the ONLY place the plaintext `key` appears.
        expect(Object.keys(body).sort()).toEqual([
            'createdAt',
            'expiresAt',
            'id',
            'key',
            'name',
            'prefix',
        ]);
        // Hard omissions — the create response must not leak stored/derived security columns nor the
        // list-only view fields.
        for (const omitted of [
            'hashedKey',
            'userId',
            'user',
            'tenantId',
            'organizationId',
            'lastUsedAt',
            'isActive',
            'updatedAt',
        ]) {
            expect(body, `create response must not carry ${omitted}`).not.toHaveProperty(omitted);
        }
        // Positive shape.
        expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
        expect(body.key, 'plaintext secret = ew_live_ + 64 hex (72 chars)').toMatch(
            /^ew_live_[0-9a-f]{64}$/,
        );
        expect(body.key).toHaveLength(72);
        expect(body.prefix, 'prefix is the 12-char head of the secret').toBe(body.key.slice(0, 12));
        expect(body.expiresAt, 'no expiry requested → null').toBeNull();
        const createdMs = new Date(body.createdAt).getTime();
        expect(Number.isNaN(createdMs), 'createdAt is a valid instant').toBe(false);
        expect(createdMs).toBeGreaterThanOrEqual(t0 - 60_000);

        // Mirror: the LIST row for the same key drops `key` and ADDS lastUsedAt/isActive (null/true).
        const row = (await listKeys(request, owner.access_token)).find((r) => r.id === body.id);
        expect(row, 'created key appears in the owner list').toBeTruthy();
        expect(row, 'list row exposes isActive that the create response omits').toHaveProperty(
            'isActive',
        );
        expect(row, 'list row exposes lastUsedAt that the create response omits').toHaveProperty(
            'lastUsedAt',
        );
        expect(row.lastUsedAt, 'never-used key lists lastUsedAt:null').toBeNull();
        expect(row.isActive).toBe(true);
        expect(JSON.stringify(row).includes(body.key), 'list row never leaks the plaintext').toBe(
            false,
        );
    });

    // =============================================================================================
    // B. expiresAt VALIDATION MATRIX — class-validator (type/format) vs service (future) branches.
    // =============================================================================================
    test('expiresAt wrong-TYPE values (number/boolean/object/array) are each rejected 400 with the ISO-8601 message, and no key row is created', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const before = (await listKeys(request, owner.access_token)).length;

        const badTypes: Array<[string, unknown]> = [
            ['number', 1_764_500_000_000],
            ['boolean', true],
            ['object', { when: '2099-01-01' }],
            ['array', ['2099-01-01T00:00:00.000Z']],
        ];
        for (const [label, value] of badTypes) {
            const r = await postKey(request, owner.access_token, {
                name: uniq('exp'),
                expiresAt: value,
            });
            expect(r.status, `expiresAt ${label} → 400; got ${r.status}`).toBe(400);
            expect(Array.isArray(r.body?.message), `${label}: message is a validator array`).toBe(
                true,
            );
            expect(JSON.stringify(r.body?.message)).toMatch(
                /expiresAt must be a valid ISO 8601 date string/i,
            );
            expect(r.body?.error, `${label}: Bad Request envelope`).toBe('Bad Request');
        }

        const after = (await listKeys(request, owner.access_token)).length;
        expect(after, 'no key row created by any rejected expiresAt-type request').toBe(before);
    });

    test('a present-but-malformed expiresAt STRING ("not-a-date", "") is 400 ISO-rejected — an EMPTY string is validated (not skipped like undefined/null)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        for (const value of ['not-a-date', 'yesterday', '13/13/2099', '']) {
            const r = await postKey(request, owner.access_token, {
                name: uniq('exp-str'),
                expiresAt: value,
            });
            expect(r.status, `expiresAt="${value}" → 400; got ${r.status}`).toBe(400);
            expect(JSON.stringify(r.body?.message)).toMatch(
                /expiresAt must be a valid ISO 8601 date string/i,
            );
            // Crucially NOT the future-check message — this is the class-validator branch, not the service.
            expect(JSON.stringify(r.body?.message)).not.toMatch(/must be in the future/i);
        }
    });

    test('expiresAt is OPTIONAL: both an explicit null and an omitted field create a non-expiring key (201, expiresAt:null)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        // Explicit null is tolerated by @IsOptional (null/undefined skip validation).
        const explicitNull = await postKey(request, owner.access_token, {
            name: uniq('null-exp'),
            expiresAt: null,
        });
        expect(
            explicitNull.status,
            `explicit null expiresAt → 201; got ${explicitNull.status}`,
        ).toBe(201);
        expect(explicitNull.body.expiresAt, 'null expiry echoed as null').toBeNull();

        // Omitted field is equivalent.
        const omitted = await postKey(request, owner.access_token, { name: uniq('omit-exp') });
        expect(omitted.status, `omitted expiresAt → 201; got ${omitted.status}`).toBe(201);
        expect(omitted.body.expiresAt, 'omitted expiry → null').toBeNull();
    });

    test('accepted non-canonical expiresAt forms are NORMALIZED to a UTC instant: a date-only string → midnight Z; a +hh:mm offset → the equivalent UTC time', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        // Date-only (no time) is a valid ISO-8601 date → accepted and stored at midnight UTC.
        const dateOnly = await mint(request, owner.access_token, uniq('date-only'), '2099-03-15');
        expect(
            new Date(dateOnly.expiresAt as string).getTime(),
            'date-only normalized to that instant',
        ).toBe(new Date('2099-03-15T00:00:00.000Z').getTime());

        // A zoned timestamp is normalized to the equivalent UTC instant (10:00+02:00 == 08:00Z).
        const zoned = await mint(
            request,
            owner.access_token,
            uniq('tz'),
            '2099-06-01T10:00:00+02:00',
        );
        expect(new Date(zoned.expiresAt as string).getTime(), 'tz-offset normalized to UTC').toBe(
            new Date('2099-06-01T08:00:00.000Z').getTime(),
        );
    });

    test('the two expiresAt rejection branches are DISTINCT: a malformed value yields the class-validator ISO message, a well-formed PAST value yields the service "must be in the future" message; a far-future value is accepted', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        // Branch 1 — malformed string never reaches the service; class-validator rejects it first.
        const malformed = await postKey(request, owner.access_token, {
            name: uniq('branch-bad'),
            expiresAt: 'definitely-not-iso',
        });
        expect(malformed.status).toBe(400);
        expect(JSON.stringify(malformed.body.message)).toMatch(/iso 8601 date string/i);
        expect(JSON.stringify(malformed.body.message)).not.toMatch(/future/i);

        // Branch 2 — a well-formed PAST date passes IsDateString but the service's own guard rejects it.
        // Note the DIFFERENT envelope: a scalar `message` string, not a validator array.
        const past = await postKey(request, owner.access_token, {
            name: uniq('branch-past'),
            expiresAt: '2000-01-01T00:00:00.000Z',
        });
        expect(past.status).toBe(400);
        expect(typeof past.body.message, 'service error is a scalar string, not an array').toBe(
            'string',
        );
        expect(past.body.message).toMatch(/Expiration date must be in the future/i);

        // Boundary: the future-check is inclusive of "now" (<=), so ~1s in the past is rejected too.
        const nowIsh = await postKey(request, owner.access_token, {
            name: uniq('branch-now'),
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
        });
        expect(nowIsh.status, 'now-1s is non-future → 400').toBe(400);
        expect(nowIsh.body.message).toMatch(/must be in the future/i);

        // A comfortably far-future value (year 9999) is accepted and echoed verbatim.
        const farFuture = await mint(
            request,
            owner.access_token,
            uniq('branch-far'),
            '9999-12-31T23:59:59.000Z',
        );
        expect(new Date(farFuture.expiresAt as string).getTime()).toBe(
            new Date('9999-12-31T23:59:59.000Z').getTime(),
        );
    });

    // =============================================================================================
    // C. "NO CAPABILITY MODEL" — every scope/permission/temporal-alias/attribution field is rejected.
    // =============================================================================================
    test('the assigned "scopes array enum" field does NOT exist: a scopes:[...] body is 400 "property scopes should not exist", the message is an array, and NO key row is created', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const before = (await listKeys(request, owner.access_token)).length;

        // The faithful inversion of "create a scoped key": forbidNonWhitelisted rejects the whole body.
        const r = await postKey(request, owner.access_token, {
            name: uniq('scoped'),
            scopes: ['works:read', 'works:write'],
        });
        expect(r.status, `scopes:[...] → 400; got ${r.status}`).toBe(400);
        expect(Array.isArray(r.body.message), 'message is a validator array').toBe(true);
        expect(JSON.stringify(r.body.message)).toMatch(/property scopes should not exist/i);
        expect(r.body.error).toBe('Bad Request');

        const after = (await listKeys(request, owner.access_token)).length;
        expect(after, 'the rejected scoped create did NOT persist a row').toBe(before);
    });

    test('scope/permission-shaped fields are each individually rejected with a per-field "should not exist" message (no OAuth-style capability surface exists)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const fields: Array<[string, unknown]> = [
            ['scope', 'works:read'],
            ['scopes', 'works:read'], // string shape of the same non-field
            ['permissions', ['read']],
            ['role', 'admin'],
            ['roles', ['admin']],
            ['abilities', ['*']],
            ['grant', '*'],
            ['access', 'rw'],
        ];
        for (const [field, value] of fields) {
            const r = await postKey(request, owner.access_token, {
                name: uniq('cap'),
                [field]: value,
            });
            expect(r.status, `${field} → 400; got ${r.status}`).toBe(400);
            expect(JSON.stringify(r.body.message)).toMatch(
                new RegExp(`property ${field} should not exist`, 'i'),
            );
        }
    });

    test('temporal-alias fields (ttl/expiresIn/expiry/expires/maxAge) are all rejected — expiresAt is the ONLY accepted expiry input', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        for (const field of ['ttl', 'expiresIn', 'expiry', 'expires', 'maxAge'] as const) {
            const r = await postKey(request, owner.access_token, {
                name: uniq('ttl'),
                [field]: 3600,
            });
            expect(r.status, `${field} → 400; got ${r.status}`).toBe(400);
            expect(JSON.stringify(r.body.message)).toMatch(
                new RegExp(`property ${field} should not exist`, 'i'),
            );
        }
    });

    test('attribution fields (userId/ownerId/tenantId/organizationId) cannot be smuggled at issue: each is 400 "should not exist" and none creates a row — a key cannot be minted for another principal/tenant', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const before = (await listKeys(request, owner.access_token)).length;
        for (const field of ['userId', 'ownerId', 'tenantId', 'organizationId'] as const) {
            const r = await postKey(request, owner.access_token, {
                name: uniq('attr'),
                [field]: '00000000-0000-0000-0000-000000000000',
            });
            expect(r.status, `${field} → 400; got ${r.status}`).toBe(400);
            expect(JSON.stringify(r.body.message)).toMatch(
                new RegExp(`property ${field} should not exist`, 'i'),
            );
        }
        const after = (await listKeys(request, owner.access_token)).length;
        expect(after, 'no attribution-smuggle attempt persisted a row').toBe(before);
    });

    // =============================================================================================
    // D. VALIDATION ENVELOPES + ACCUMULATION.
    // =============================================================================================
    test('an empty {} body reports the full name-validator ARRAY (3 messages) inside the canonical {error:"Bad Request",statusCode:400} envelope', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const r = await postKey(request, owner.access_token, {});
        expect(r.status).toBe(400);
        expect(Array.isArray(r.body.message), 'message is an array of violations').toBe(true);
        // All three @IsString/@IsNotEmpty/@MaxLength violations are reported for the missing name.
        const joined = JSON.stringify(r.body.message);
        expect(joined).toMatch(/name should not be empty/i);
        expect(joined).toMatch(/name must be a string/i);
        expect(joined).toMatch(/shorter than or equal to 100 characters/i);
        expect((r.body.message as string[]).length, 'exactly the three name violations').toBe(3);
        // Exact error envelope.
        expect(r.body.error).toBe('Bad Request');
        expect(r.body.statusCode).toBe(400);
    });

    test('multi-family violations ACCUMULATE into one message array (unknown-field + name-type + expiresAt-format) and the whole body is atomically rejected — forbidNonWhitelisted does not strip', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const before = (await listKeys(request, owner.access_token)).length;

        // One request carrying THREE different classes of violation at once.
        const r = await postKey(request, owner.access_token, {
            name: 123, // wrong type
            expiresAt: 'nope', // bad format
            scopes: ['x'], // unknown field
        });
        expect(r.status).toBe(400);
        const joined = JSON.stringify(r.body.message);
        expect(joined, 'unknown-field violation present').toMatch(
            /property scopes should not exist/i,
        );
        expect(joined, 'name-type violation present').toMatch(/name must be a string/i);
        expect(joined, 'expiresAt-format violation present').toMatch(/iso 8601 date string/i);

        // Atomicity: even an OTHERWISE-VALID body is rejected outright by a single stray field — the
        // pipe rejects rather than silently stripping, so no partial/laundered row is created.
        const stray = await postKey(request, owner.access_token, {
            name: uniq('otherwise-valid'),
            expiresAt: '2099-01-01T00:00:00.000Z',
            somethingExtra: 'x',
        });
        expect(stray.status, 'a lone stray field 400s an otherwise-valid body').toBe(400);
        expect(JSON.stringify(stray.body.message)).toMatch(
            /property somethingExtra should not exist/i,
        );

        const after = (await listKeys(request, owner.access_token)).length;
        expect(after, 'neither rejected body created a row').toBe(before);
    });

    test('name of a non-primitive type (array or object) trips @IsString → 400 "name must be a string"', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        for (const [label, value] of [
            ['array', ['a', 'b']],
            ['object', { first: 'a' }],
        ] as Array<[string, unknown]>) {
            const r = await postKey(request, owner.access_token, { name: value });
            expect(r.status, `name ${label} → 400; got ${r.status}`).toBe(400);
            expect(JSON.stringify(r.body.message)).toMatch(/name must be a string/i);
        }
    });

    test('non-object request bodies ([] and a bare JSON scalar) are rejected 400 and never 500', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        // An array body is coerced through the DTO with no `name` → the 3 name violations.
        const arr = await postKey(request, owner.access_token, []);
        expect(arr.status, `[] body → 400; got ${arr.status}`).toBe(400);
        expect(arr.status).not.toBe(500);
        expect(JSON.stringify(arr.body?.message ?? '')).toMatch(
            /name should not be empty|name must be a string/i,
        );

        // A bare JSON scalar is a body-parser 400 (message shape is parser-defined) — must not 500.
        const scalar = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: '"just-a-string"' as any,
            failOnStatusCode: false,
        });
        expect([400, 415, 422], `scalar body rejected; got ${scalar.status()}`).toContain(
            scalar.status(),
        );
        expect(scalar.status()).not.toBe(500);
    });

    // =============================================================================================
    // E. AUTH ENVELOPES + ORDERING.
    // =============================================================================================
    test('anonymous callers get the EXACT 401 {message:"Unauthorized",statusCode:401} envelope on POST and GET — with NO `error` field (distinct from the 400/404 envelopes)', async ({
        request,
    }) => {
        const anonPost = await request.post(KEYS, {
            headers: { 'content-type': 'application/json' },
            data: { name: uniq('anon') },
            failOnStatusCode: false,
        });
        expect(anonPost.status(), 'anon POST → 401').toBe(401);
        const postBody = await anonPost.json().catch(() => ({}));
        expect(postBody.message).toBe('Unauthorized');
        expect(postBody.statusCode).toBe(401);
        expect(postBody, '401 envelope has no `error` field (unlike 400/404)').not.toHaveProperty(
            'error',
        );

        const anonGet = await request.get(KEYS, { failOnStatusCode: false });
        expect(anonGet.status(), 'anon GET → 401').toBe(401);
        expect((await anonGet.json().catch(() => ({}))).message).toBe('Unauthorized');
    });

    test('authentication runs BEFORE the existence check: an anonymous DELETE of a well-formed nonexistent uuid → 401 (not 404), while the same id with a valid Bearer → 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const ghost = '00000000-0000-0000-0000-000000000000';

        // No credential → the guard short-circuits with 401 BEFORE the service can report not-found.
        const anon = await request.delete(`${KEYS}/${ghost}`, { failOnStatusCode: false });
        expect(anon.status(), 'anon DELETE of a ghost id → 401 (auth first)').toBe(401);
        expect((await anon.json().catch(() => ({}))).message).toBe('Unauthorized');

        // Same id, now authenticated → we reach the service, which reports 404.
        const authed = await request.delete(`${KEYS}/${ghost}`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect(authed.status(), 'authed DELETE of a ghost id → 404 (existence checked)').toBe(404);
        expect((await authed.json().catch(() => ({}))).message).toMatch(/API key not found/i);
    });

    test('malformed Authorization headers (Bearer-no-token, Bearer-whitespace, wrong scheme, raw token) are each 401 on the management list — never 500', async ({
        request,
    }) => {
        const badHeaders: Array<[string, string]> = [
            ['Bearer (no token)', 'Bearer'],
            ['Bearer + whitespace', 'Bearer      '],
            ['wrong scheme', 'Token abc123'],
            ['raw token, no scheme', 'sometoken-without-a-scheme'],
            ['Basic scheme', 'Basic dXNlcjpwYXNz'],
        ];
        for (const [label, value] of badHeaders) {
            const res = await request.get(KEYS, {
                headers: { Authorization: value },
                failOnStatusCode: false,
            });
            expect(res.status(), `${label} → 401; got ${res.status()}`).toBe(401);
            expect(res.status(), `${label} never 500`).not.toBe(500);
        }
    });

    test('a syntactically-valid but bogus opaque Bearer token is rejected 401 on create (the token must resolve to a real session)', async ({
        request,
    }) => {
        const bogus = await request.post(KEYS, {
            headers: {
                Authorization: 'Bearer 00000000000000000000000000000000',
                'content-type': 'application/json',
            },
            data: { name: uniq('bogus') },
            failOnStatusCode: false,
        });
        expect(bogus.status(), 'bogus opaque token → 401').toBe(401);
        expect(bogus.status()).not.toBe(500);
    });

    // =============================================================================================
    // F. CROSS-USER POSTURE + REVOKE CONTRACT.
    // =============================================================================================
    test("cross-user DELETE is 404 NOT 403 (existence-hiding) with the exact 'API key not found' envelope, and it is a proven no-op — the victim key stays in its owner's list and never appears in the attacker's", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        expect(owner.user.id).not.toBe(attacker.user.id);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const victim = await mint(request, owner.access_token, uniq('victim'));

        // The attacker knows the id but cannot act on it. The 404 (never 403) leaks no existence signal:
        // "not yours" is indistinguishable from "doesn't exist".
        const cross = await request.delete(`${KEYS}/${victim.id}`, {
            headers: authedHeaders(attacker.access_token),
            failOnStatusCode: false,
        });
        expect(cross.status(), 'cross-user DELETE → 404 (never 403)').toBe(404);
        expect(cross.status(), 'existence-hiding: not a 403 Forbidden').not.toBe(403);
        const crossBody = await cross.json().catch(() => ({}));
        expect(crossBody.message).toBe('API key not found');
        expect(crossBody.error).toBe('Not Found');
        expect(crossBody.statusCode).toBe(404);

        // No-op proof: the row is untouched — present for its owner, absent for the attacker.
        const ownerIds = (await listKeys(request, owner.access_token)).map((r) => r.id);
        expect(ownerIds, "victim key survives the attacker's failed revoke").toContain(victim.id);
        const attackerIds = (await listKeys(request, attacker.access_token)).map((r) => r.id);
        expect(attackerIds, "attacker's list never contains the victim key").not.toContain(
            victim.id,
        );
    });

    test('owner revoke returns the EXACT {message:"API key revoked successfully"} body; the idempotent second revoke returns the EXACT 404 envelope; the row is dropped from the list', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const key = await mint(request, owner.access_token, uniq('revoke'));
        expect((await listKeys(request, owner.access_token)).map((r) => r.id)).toContain(key.id);

        const revoke = await request.delete(`${KEYS}/${key.id}`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect(revoke.status(), 'owner revoke → 200').toBe(200);
        // EXACT success body (siblings only regex /revoked/i; here we pin the whole payload).
        expect(await revoke.json()).toEqual({ message: 'API key revoked successfully' });

        // The row is gone.
        expect(
            (await listKeys(request, owner.access_token)).map((r) => r.id),
            'revoked key dropped from list',
        ).not.toContain(key.id);

        // Idempotent second revoke → the exact NotFound envelope (deleteByIdAndUserId returned false).
        const again = await request.delete(`${KEYS}/${key.id}`, {
            headers: authedHeaders(owner.access_token),
            failOnStatusCode: false,
        });
        expect(again.status(), 'second revoke → 404').toBe(404);
        expect(await again.json()).toEqual({
            message: 'API key not found',
            error: 'Not Found',
            statusCode: 404,
        });
    });

    // =============================================================================================
    // G. EMPTY-STATE + validator field-independence.
    // =============================================================================================
    test('a brand-new user has an empty list (200 []); after one create the list contains exactly that id with lastUsedAt:null and isActive:true before any use', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        // Empty-state precondition: a freshly-registered user owns zero keys.
        const empty = await listKeys(request, owner.access_token);
        expect(empty, 'brand-new user has no keys').toHaveLength(0);

        const created = await mint(request, owner.access_token, uniq('first'));
        const rows = await listKeys(request, owner.access_token);
        expect(
            rows.map((r) => r.id),
            'the single created key is now listed',
        ).toContain(created.id);
        const row = rows.find((r) => r.id === created.id);
        expect(row.name, 'list row name matches create').toBe(created.name);
        expect(row.prefix, 'list row prefix matches create').toBe(created.prefix);
        expect(row.lastUsedAt, 'never-used → lastUsedAt null').toBeNull();
        expect(row.isActive, 'a fresh key is active').toBe(true);
    });

    test('the name and expiresAt validators are INDEPENDENT: a 100-char name + a valid future expiresAt is 201; bumping the name to 101 chars 400s on the NAME alone while the (valid) expiresAt is not blamed', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        if (!(await keysFeaturePresent(request, owner.access_token))) {
            test.skip(true, 'api-keys surface absent in this driver');
            return;
        }
        const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        // Both fields at their accepted extremes together → 201.
        const ok = await postKey(request, owner.access_token, {
            name: 'a'.repeat(100),
            expiresAt: future,
        });
        expect(ok.status, `100-char name + future expiry → 201; got ${ok.status}`).toBe(201);
        expect(ok.body.name).toHaveLength(100);
        expect(new Date(ok.body.expiresAt).getTime()).toBe(new Date(future).getTime());

        // One over on the name → 400 naming ONLY the name; the still-valid expiresAt is not implicated.
        const over = await postKey(request, owner.access_token, {
            name: 'a'.repeat(101),
            expiresAt: future,
        });
        expect(over.status, `101-char name → 400; got ${over.status}`).toBe(400);
        const joined = JSON.stringify(over.body.message);
        expect(joined, 'name length is the reported violation').toMatch(
            /shorter than or equal to 100 characters/i,
        );
        expect(joined, 'the valid expiresAt is NOT blamed').not.toMatch(
            /expiresAt|iso 8601|future/i,
        );
    });
});
