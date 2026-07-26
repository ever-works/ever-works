import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-account-validation-authz-matrix
 *
 * A dense VALIDATION + AUTHZ matrix for the account-management surface —
 * one assertion cluster per DTO field, the full unauthenticated/whitelist
 * posture, and the DoS-payload bounds the account-transfer controller adds.
 * This is deliberately NOT the happy-path CRUD/round-trip the sibling specs
 * already own; it pins the rejection contract those specs leave open.
 *
 * NON-DUPLICATION (surveyed every flow-account-* / auth sibling):
 *   - flow-account-data-deletion / -export-import-roundtrip → the VALID
 *     export→preview→apply round-trip + top-level shape guards + the
 *     no-deletion-endpoint contract.
 *   - flow-account-import-validation → per-ELEMENT malformed-array regression
 *     (null element, work-missing-name, bare-string userPlugin).
 *   - flow-account-research-optout → opt-out persistence/reversibility/gating.
 *   - flow-account-sync-lifecycle → all six /api/account/sync routes.
 *   NET-NEW HERE: the PUT /api/auth/profile UpdateProfileDto field matrix
 *   (username / avatar / committerName / committerEmail / emailBudgetAlerts),
 *   the import DoS array-size caps (works/userPlugins > 5000), the
 *   structural-body-vs-class-validator-DTO whitelist contrast, the
 *   apply "Invalid payload" clean-failure envelope, and the prefs-DTO
 *   forbidNonWhitelisted + account-scope isolation.
 *
 * PROBED LIVE (http://127.0.0.1:3100) before every assertion below.
 *
 * PUT /api/auth/profile  (UpdateProfileDto, AuthSessionGuard, whitelist ON) —
 *   returns the FRESH DB user ({ id, username, slug, email, avatar,
 *   committerName, committerEmail, emailVerified, ... }). All fields optional:
 *     - username      @IsString @MinLength(3)
 *         "ab"/""      → 400 ["username must be longer than or equal to 3 characters"]
 *         123          → 400 [<minlen>, "username must be a string"]
 *         "abc"        → 200 (3-char boundary), echoes username
 *     - avatar        @IsUrl
 *         "x"/12345/"" → 400 ["avatar must be a URL address"]
 *         https URL    → 200, echoes avatar
 *     - committerName @IsString @MaxLength(120) @Matches(/^[^\r\n\x00-\x1F\x7F]+$/)
 *         newline / CR / tab / NUL / DEL (0x00-0x1F, 0x7F) → 400 ["committerName must not contain newline or control characters"]
 *         121 chars    → 400 ["committerName must be shorter than or equal to 120 characters"]
 *         120 chars / "Jane Dev" / null → 200
 *     - committerEmail @IsEmail
 *         "bad"        → 400 ["committerEmail must be an email"]
 *         "c@d.com"    → 200, echoes committerEmail
 *     - emailBudgetAlerts @IsBoolean
 *         "yes"        → 400 ["emailBudgetAlerts must be a boolean value"]
 *         true/false   → 200
 *     - unknown field  → 400 ["property <x> should not exist"] (forbidNonWhitelisted)
 *     - {} empty body  → 200 idempotent no-op (echoes unchanged DB user)
 *     - PATCH (route is @Put) → 404 ;  no/invalid bearer → 401
 *   GET /api/auth/profile → 200 JWT-projection { id, userId, email, username,
 *     provider, emailVerified, isActive, avatar, isAnonymous } — deliberately
 *     no committerEmail / tenantId / iat leak.
 *
 * POST /api/account/import/preview | /apply  (structural body — NOT a
 *   class-validator DTO, so no forbidNonWhitelisted; controller adds explicit
 *   DoS caps + an empty-body guard):
 *     - works.length    > 5000 → 400 "Import payload too large: works exceeds 5000"
 *     - userPlugins.len > 5000 → 400 "Import payload too large: userPlugins exceeds 5000"
 *       (apply guards body.payload identically)
 *     - preview {}      → 400 "Request body is empty"
 *     - preview extra top-level field → 200 valid:true (structural body tolerates it)
 *     - apply {} / missing payload → 200 { success:false, errors:["Invalid payload: expected a JSON object"] }
 *     - no bearer → 401 on both
 *
 * PUT /api/me/work-proposals/preferences (UpdateWorkProposalPreferencesDto, whitelist ON):
 *     - unknown field → 400 ["property <x> should not exist"] even beside a valid optOut
 *     - opt-out is account-scoped (A's opt-out never bleeds into a fresh B)
 *
 * Isolation: every test registers FRESH users via registerUserViaAPI() — the
 * shared seeded user (storageState) is never touched. Unique suffixes keep
 * parallel workers from colliding.
 */

const PROFILE = `${API_BASE}/api/auth/profile`;
const PREVIEW = `${API_BASE}/api/account/import/preview`;
const APPLY = `${API_BASE}/api/account/import/apply`;
const PREFS = `${API_BASE}/api/me/work-proposals/preferences`;

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface ProfileEcho {
    id: string;
    username?: string;
    email?: string;
    avatar?: string | null;
    committerName?: string | null;
    committerEmail?: string | null;
}

/** Raw PUT /api/auth/profile — caller asserts status + body. */
function putProfile(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<APIResponse> {
    return request.put(PROFILE, { headers: authedHeaders(token), data: body });
}

/** PUT that must succeed; returns the echoed fresh-DB profile. */
async function putProfileOk(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<ProfileEcho> {
    const res = await putProfile(request, token, body);
    expect(
        res.status(),
        `PUT ${JSON.stringify(body)} body=${await res.text().catch(() => '')}`,
    ).toBe(200);
    return (await res.json()) as ProfileEcho;
}

/** Normalize a Nest validation error body's `message` to a string[]. */
async function messagesOf(res: APIResponse): Promise<string[]> {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    if (Array.isArray(body.message)) return body.message.map(String);
    return [String(body.message ?? '')];
}

async function messageStr(res: APIResponse): Promise<string> {
    return (await messagesOf(res)).join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────
// PROFILE — username field
// ─────────────────────────────────────────────────────────────────────────
test.describe('Profile update — username field (PUT /api/auth/profile)', () => {
    test('rejects too-short and empty usernames with the MinLength(3) message; never persists', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const original = await putProfileOk(request, token, {}); // read current

        for (const bad of ['ab', 'a', '']) {
            const res = await putProfile(request, token, { username: bad });
            expect(res.status(), `username="${bad}" → 400`).toBe(400);
            expect(await messageStr(res)).toContain(
                'username must be longer than or equal to 3 characters',
            );
        }

        // The rejected writes never landed — a no-op read shows the untouched name.
        const after = await putProfileOk(request, token, {});
        expect(after.username).toBe(original.username);
    });

    test('rejects a non-string username with BOTH the type and MinLength messages', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const res = await putProfile(request, token, { username: 123 });
        expect(res.status()).toBe(400);
        const msg = await messageStr(res);
        expect(msg).toContain('username must be a string');
        expect(msg).toContain('username must be longer than or equal to 3 characters');
    });

    test('accepts the 3-character boundary and persists it across a follow-up read', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const name = `u${uniq()}`.slice(0, 12); // >= 3, safe chars

        const echo = await putProfileOk(request, token, { username: name });
        expect(echo.username, 'PUT echoes the new username from the DB').toBe(name);

        // A subsequent no-op {} PUT re-reads the DB user — the value stuck.
        const reread = await putProfileOk(request, token, {});
        expect(reread.username, 'username persisted across requests').toBe(name);

        // Exact 3-char boundary is valid (MinLength is inclusive).
        const three = await putProfileOk(request, token, { username: 'abc' });
        expect(three.username).toBe('abc');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// PROFILE — avatar field
// ─────────────────────────────────────────────────────────────────────────
test.describe('Profile update — avatar URL field', () => {
    test('rejects a non-URL string, a number, and an empty string with the IsUrl message', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        for (const bad of ['not-a-url', 12345, ''] as const) {
            const res = await putProfile(request, token, { avatar: bad });
            expect(res.status(), `avatar=${JSON.stringify(bad)} → 400`).toBe(400);
            expect(await messageStr(res)).toContain('avatar must be a URL address');
        }
    });

    test('accepts a well-formed https URL and echoes + persists it', async ({ request }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const url = `https://cdn.example.com/${uniq()}.png`;

        const echo = await putProfileOk(request, token, { avatar: url });
        expect(echo.avatar, 'PUT echoes the stored avatar').toBe(url);

        const reread = await putProfileOk(request, token, {});
        expect(reread.avatar, 'avatar persisted').toBe(url);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// PROFILE — committerName field (git-safety validators)
// ─────────────────────────────────────────────────────────────────────────
test.describe('Profile update — committerName (length + control-char guard)', () => {
    test('rejects newline / CR / tab / NUL / DEL control characters (git commit-object safety)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
            const res = await putProfile(request, token, { committerName: bad });
            expect(res.status(), `committerName=${JSON.stringify(bad)} → 400`).toBe(400);
            expect(await messageStr(res)).toContain(
                'committerName must not contain newline or control characters',
            );
        }
    });

    test('enforces the MaxLength(120) DB-column bound — 121 rejected, exactly 120 accepted', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        const over = await putProfile(request, token, { committerName: 'a'.repeat(121) });
        expect(over.status()).toBe(400);
        expect(await messageStr(over)).toContain(
            'committerName must be shorter than or equal to 120 characters',
        );

        const at = await putProfileOk(request, token, { committerName: 'a'.repeat(120) });
        expect((at.committerName ?? '').length, 'exactly-120 committerName persists').toBe(120);
    });

    test('accepts a clean name and a null "clear override" without error', async ({ request }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        const set = await putProfileOk(request, token, { committerName: 'Jane Dev' });
        expect(set.committerName).toBe('Jane Dev');

        // null is the documented clear-override path (@IsOptional lets it through).
        const cleared = await putProfileOk(request, token, { committerName: null });
        expect(cleared.committerName ?? null, 'null clears the override').toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// PROFILE — committerEmail + emailBudgetAlerts
// ─────────────────────────────────────────────────────────────────────────
test.describe('Profile update — committerEmail + emailBudgetAlerts fields', () => {
    test('committerEmail rejects a malformed address and accepts a valid one', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        for (const bad of ['bad', 'no-at-sign', 'a@']) {
            const res = await putProfile(request, token, { committerEmail: bad });
            expect(res.status(), `committerEmail="${bad}" → 400`).toBe(400);
            expect(await messageStr(res)).toContain('committerEmail must be an email');
        }

        const ok = await putProfileOk(request, token, {
            committerEmail: `dev-${uniq()}@example.com`,
        });
        expect(ok.committerEmail, 'valid committer email is stored').toContain('@example.com');
    });

    test('emailBudgetAlerts rejects a non-boolean and accepts true/false', async ({ request }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        for (const bad of ['yes', 1, 'true'] as const) {
            const res = await putProfile(request, token, { emailBudgetAlerts: bad });
            expect(res.status(), `emailBudgetAlerts=${JSON.stringify(bad)} → 400`).toBe(400);
            expect(await messageStr(res)).toContain('emailBudgetAlerts must be a boolean value');
        }

        // Both boolean values validate cleanly.
        await putProfileOk(request, token, { emailBudgetAlerts: true });
        await putProfileOk(request, token, { emailBudgetAlerts: false });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// PROFILE — body / whitelist / method / authz posture
// ─────────────────────────────────────────────────────────────────────────
test.describe('Profile update — whitelist, empty-body, method, and authz', () => {
    test('forbidNonWhitelisted: an unknown property is rejected with the exact property message', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        const single = await putProfile(request, token, { nickname: 'x' });
        expect(single.status()).toBe(400);
        expect(await messageStr(single)).toContain('property nickname should not exist');

        // Even a payload mixing a VALID field with an unknown one is rejected whole.
        const mixed = await putProfile(request, token, { username: 'validname', role: 'admin' });
        expect(mixed.status(), 'a valid field cannot smuggle an unknown one through').toBe(400);
        expect(await messageStr(mixed)).toContain('property role should not exist');
    });

    test('an empty {} body is an idempotent no-op that echoes the unchanged profile', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const first = await putProfileOk(request, token, {});
        expect(first.email, 'the no-op echoes THIS user profile').toBe(user.email);
        expect(first.id).toBeTruthy();

        const second = await putProfileOk(request, token, {});
        expect(second.username, 'a second no-op is stable (no mutation)').toBe(first.username);
    });

    test('a multi-field invalid body aggregates every failing field into one 400', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const res = await putProfile(request, token, {
            username: 'aa', // too short
            avatar: 'x', // not a url
            committerEmail: 'bad', // not an email
        });
        expect(res.status()).toBe(400);
        const msg = await messageStr(res);
        expect(msg).toContain('username must be longer than or equal to 3 characters');
        expect(msg).toContain('avatar must be a URL address');
        expect(msg).toContain('committerEmail must be an email');
    });

    test('the profile route only answers PUT/GET — PATCH is 404, and GET is a lean JWT projection', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        // Route is @Put('profile'); PATCH has no handler → route-not-found.
        const patch = await request.patch(PROFILE, {
            headers: authedHeaders(token),
            data: { username: 'abc' },
        });
        expect([404, 405]).toContain(patch.status());

        // GET returns a whitelist projection that never leaks the internal
        // tenantId / JWT-envelope claims / committer overrides (EW-722).
        const get = await request.get(PROFILE, { headers: authedHeaders(token) });
        expect(get.status()).toBe(200);
        const body = (await get.json()) as Record<string, unknown>;
        expect(body.id, 'projection carries the canonical id').toBeTruthy();
        expect(body.email).toBeTruthy();
        expect('username' in body).toBe(true);
        expect(body.tenantId, 'internal tenantId is NOT exposed').toBeUndefined();
        expect(body.iat, 'JWT envelope claims are NOT exposed').toBeUndefined();
        expect(
            body.committerEmail,
            'committer override is NOT part of the JWT projection',
        ).toBeUndefined();
    });

    test('the update is JWT-gated: no bearer → 401, garbage bearer → 401', async ({ request }) => {
        const anon = await request.put(PROFILE, { data: { username: 'abcdef' } });
        expect(anon.status()).toBe(401);

        const bad = await request.put(PROFILE, {
            headers: { Authorization: 'Bearer not-a-real-token' },
            data: { username: 'abcdef' },
        });
        expect(bad.status()).toBe(401);
    });

    test('profile is per-user: A updating their username never mutates B', async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        const newName = `a-${uniq()}`.slice(0, 14);
        const aEcho = await putProfileOk(request, a.access_token, { username: newName });
        expect(aEcho.username).toBe(newName);

        // B's own no-op read is unchanged by A's write — no cross-account bleed.
        const bEcho = await putProfileOk(request, b.access_token, {});
        expect(bEcho.email).toBe(b.email);
        expect(bEcho.username, "A's rename did not touch B").not.toBe(newName);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// IMPORT — DoS payload bounds (preview + apply share the guard)
// ─────────────────────────────────────────────────────────────────────────
test.describe('Import — DoS array-size caps (POST /api/account/import/{preview,apply})', () => {
    test('preview rejects a works array beyond the 5000 cap with the exact 400', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const works = Array.from({ length: 5001 }, (_, i) => ({ slug: `s${i}`, name: `N${i}` }));
        const res = await request.post(PREVIEW, {
            headers: authedHeaders(token),
            data: { version: 1, data: { profile: {}, works, userPlugins: [] } },
        });
        expect(res.status(), 'oversized works → 400, not a 5xx OOM').toBe(400);
        expect((await res.json()).message).toBe('Import payload too large: works exceeds 5000');
    });

    test('preview rejects a userPlugins array beyond the 5000 cap', async ({ request }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const userPlugins = Array.from({ length: 5001 }, (_, i) => ({ pluginId: `p${i}` }));
        const res = await request.post(PREVIEW, {
            headers: authedHeaders(token),
            data: { version: 1, data: { profile: {}, works: [], userPlugins } },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toBe(
            'Import payload too large: userPlugins exceeds 5000',
        );
    });

    test('apply enforces the SAME cap on body.payload before the transaction opens', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const works = Array.from({ length: 5001 }, (_, i) => ({ slug: `s${i}`, name: `N${i}` }));
        const res = await request.post(APPLY, {
            headers: authedHeaders(token),
            data: {
                payload: { version: 1, data: { profile: {}, works, userPlugins: [] } },
                resolutions: [],
            },
        });
        expect(res.status(), 'apply guards the payload identically to preview').toBe(400);
        expect((await res.json()).message).toBe('Import payload too large: works exceeds 5000');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// IMPORT — structural body semantics + failure envelopes
// ─────────────────────────────────────────────────────────────────────────
test.describe('Import — structural body (no DTO whitelist) + clean failure envelopes', () => {
    test('the import body is NOT a class-validator DTO: an unknown TOP-LEVEL field is tolerated', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        // The profile/prefs endpoints 400 on an extra field; the import payload is
        // a plain structural interface, so ValidationPipe applies NO whitelist here.
        const res = await request.post(PREVIEW, {
            headers: authedHeaders(token),
            data: {
                version: 1,
                data: { profile: { username: 'u', email: 'u@e.co' }, works: [], userPlugins: [] },
                bogusTopLevel: 'ignored',
            },
        });
        expect(res.status(), 'extra top-level field does not 400 (structural body)').toBe(200);
        const body = await res.json();
        expect(
            body.valid,
            'a structurally valid payload previews as valid despite the extra key',
        ).toBe(true);
        expect(body.errors).toEqual([]);
    });

    test('preview: an empty {} body is a clean 400 guard, a modest valid payload is 200 valid:true', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        const empty = await request.post(PREVIEW, { headers: authedHeaders(token), data: {} });
        expect(empty.status(), 'empty preview body → 400 (controller guard, not 500)').toBe(400);
        expect((await empty.json()).message).toBe('Request body is empty');

        const okRes = await request.post(PREVIEW, {
            headers: authedHeaders(token),
            data: {
                version: 1,
                data: {
                    profile: { username: 'u', email: 'u@e.co' },
                    works: [{ slug: 'w1', name: 'W1' }],
                    userPlugins: [],
                },
            },
        });
        expect(okRes.status()).toBe(200);
        const preview = await okRes.json();
        expect(preview.valid).toBe(true);
        expect(preview.workCount).toBe(1);
        expect(preview.userPluginCount).toBe(0);
    });

    test('apply: a missing / empty payload returns a clean failed ImportResult (never a 5xx)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        for (const body of [{ resolutions: [] }, {}]) {
            const res = await request.post(APPLY, { headers: authedHeaders(token), data: body });
            expect(res.status(), `apply(${JSON.stringify(body)}) → 200, not 5xx`).toBe(200);
            const result = await res.json();
            expect(result.success, 'a payload-less apply reports failure, not success').toBe(false);
            expect(
                (result.errors as string[]).some((e) =>
                    /Invalid payload: expected a JSON object/.test(e),
                ),
                `expected the invalid-payload error; got ${JSON.stringify(result.errors)}`,
            ).toBe(true);
            // The five counters are still a well-formed numeric envelope.
            for (const k of [
                'worksCreated',
                'worksUpdated',
                'worksSkipped',
                'userPluginsImported',
            ] as const) {
                expect(typeof result[k]).toBe('number');
            }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────
// AUTHZ + PREFS whitelist — shared account-management authz posture
// ─────────────────────────────────────────────────────────────────────────
test.describe('Account-management — authz gate + research-prefs whitelist/isolation', () => {
    test('import preview and apply both require a bearer → 401 unauthenticated', async ({
        request,
    }) => {
        const previewAnon = await request.post(PREVIEW, { data: { version: 1, data: {} } });
        expect(previewAnon.status(), 'unauth preview → 401').toBe(401);

        const applyAnon = await request.post(APPLY, { data: { payload: {}, resolutions: [] } });
        expect(applyAnon.status(), 'unauth apply → 401').toBe(401);

        // A garbage bearer is likewise rejected, not silently treated as anonymous.
        const badBearer = await request.post(PREVIEW, {
            headers: { Authorization: 'Bearer nope' },
            data: { version: 1, data: {} },
        });
        expect(badBearer.status()).toBe(401);
    });

    test('research-preferences PUT is whitelisted: an unknown field 400s even beside a valid optOut', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const res = await request.put(PREFS, {
            headers: authedHeaders(token),
            data: { optOut: true, bogus: 1 },
        });
        expect(res.status(), 'a valid optOut cannot carry an unknown field through').toBe(400);
        expect(await messageStr(res)).toContain('property bogus should not exist');

        // The rejected write never landed: the user is still at the opted-in default.
        const get = await request.get(PREFS, { headers: authedHeaders(token) });
        expect(get.status()).toBe(200);
        expect((await get.json()).optOut).toBe(false);
    });

    test('research opt-out is account-scoped — A opting out never bleeds into a fresh B', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        // A opts OUT.
        const aPut = await request.put(PREFS, {
            headers: authedHeaders(a.access_token),
            data: { optOut: true },
        });
        expect(aPut.status()).toBe(200);
        expect((await aPut.json()).optOut).toBe(true);

        // B, registered independently, still reads the opted-IN default.
        const bGet = await request.get(PREFS, { headers: authedHeaders(b.access_token) });
        expect(bGet.status()).toBe(200);
        expect((await bGet.json()).optOut, "A's opt-out did not affect B").toBe(false);

        // A's own state is unchanged by B's read.
        const aGet = await request.get(PREFS, { headers: authedHeaders(a.access_token) });
        expect((await aGet.json()).optOut).toBe(true);
    });
});
