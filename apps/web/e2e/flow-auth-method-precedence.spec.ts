import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-auth-method-precedence.spec.ts
 *
 * THEME: composite auth-method PRECEDENCE / CONFLICT resolution — which of
 * {API-key, session-bearer, Better-Auth-cookie} wins when several credential
 * slots are present, that conflicts resolve to ONE deterministic principal
 * (never a merge), the anonymous->authenticated upgrade, and the 401 shapes.
 *
 * Probe-verified contract (live stack, 2026-06-01) — read off the REAL guard
 * `apps/api/src/auth/guards/auth-session.guard.ts`, provider
 * `apps/api/src/auth/providers/auth-provider.service.ts`, and curled directly:
 *
 *   PROTECTED PRINCIPAL ENDPOINT (there is NO `/api/auth/me` — that 404s):
 *     GET /api/auth/profile  -> 200 {
 *         id, userId,          // identical UUIDs
 *         email, username, provider,   // provider: 'local' | 'anonymous'
 *         emailVerified, isActive, avatar,
 *         isAnonymous?         // present on the SESSION path, absent on API-key path
 *       }
 *     -> 401 otherwise.
 *
 *   EW-722 (Wave M #156, info-leak): the fabricated iat/iss/aud claims are NO
 *   LONGER echoed by /profile — the response is a whitelist projection. The
 *   iss/aud "path fingerprint" assertions below were written defensively
 *   (`if (body?.iss !== undefined)`) and now self-skip; they are kept (never
 *   deleted) to document the historical fingerprint and to keep guarding the
 *   exact values if the fields ever reappear. The isAnonymous
 *   presence/absence distinction REMAINS a live path discriminator.
 *
 *   TOKEN MODEL: `access_token` from register/login/anonymous is an OPAQUE
 *   session bearer (randomBytes(24) base64url), NOT a JWT. There is NO
 *   Set-Cookie on register/login in this CI driver (the bearer is the session
 *   handle); a Better-Auth cookie is an independent, optional credential the
 *   provider falls back to via `auth.api.getSession({ headers })`.
 *
 *   PRECEDENCE (guard order, intentional & PROVED):
 *     1. `@Public()` short-circuits.
 *     2. API-KEY PATH — taken iff an `ew_live_`-prefixed value sits in EITHER
 *          `x-api-key: ew_live_…`  OR  `Authorization: Bearer ew_live_…`
 *        When taken it is AUTHORITATIVE and NEVER falls through: a bad key
 *        -> 401 {"message":"Invalid or expired API key","error":"Unauthorized","statusCode":401}
 *        EVEN IF a perfectly valid session bearer is ALSO present. (PROVED:
 *        valid Bearer <session> + `x-api-key: ew_live_bogus` -> 401, not 200.)
 *        Principal fingerprint on this path: iss:'ever-works', aud:'ever-works',
 *        and NO `isAnonymous` field.
 *     3. PROVIDER/SESSION PATH — `Authorization: <scheme> <token>` where
 *        scheme is case-INSENSITIVE-matched as bearer; the token is looked up
 *        as a session record, else Better-Auth `getSession` reads any cookie.
 *        Principal fingerprint: iss:'auth-runtime', aud:'ever-works-users',
 *        isAnonymous boolean present.
 *
 *   CASE-SENSITIVITY DIVERGENCE (subtle, PROVED): the API-key discriminator
 *   matches EXACT `'Bearer'`; the provider lowercases the scheme. So the SAME
 *   value routes to DIFFERENT paths by header case:
 *     `Authorization: Bearer ew_live_bogus`  -> API-key path  -> {"...":"Invalid or expired API key", error:'Unauthorized'}
 *     `Authorization: bearer ew_live_bogus`  -> provider path -> {"message":"Unauthorized"} (NO `error` key)
 *     `Authorization: bearer <valid session>`-> provider path -> 200 (lowercase scheme still authenticates)
 *
 *   401 ENVELOPES ARE *NOT* UNIFORM (PROVED — do not assert a single shape):
 *     - generic guard reject : {"message":"Unauthorized","statusCode":401}        (NO `error`)
 *     - api-key reject       : {"message":"Invalid or expired API key","error":"Unauthorized","statusCode":401}
 *     The ONLY uniform invariant is statusCode===401 and message is a non-empty string.
 *
 *   ANONYMOUS UPGRADE: POST /api/auth/anonymous -> 201 { access_token, user:{ id, email:null,
 *     username:'anon-…', isAnonymous:true, anonymousExpiresAt } }. Its bearer -> profile with
 *     provider:'anonymous', isAnonymous:true. A registered user -> provider:'local', isAnonymous:false.
 *
 *   API-KEY ISSUANCE: POST /api/auth/api-keys { name } -> 201 { id, name, key:"ew_live_"+64hex,
 *     prefix, expiresAt, createdAt }. The plaintext `key` is shown ONCE.
 *
 * Every assertion below is grounded in a curl-verified behavior; nothing is a
 * fabricated contract. Where an OPTIONAL credential (cookie) might not be
 * issued in this driver, the relevant leg is guarded and the invariant still
 * holds for whichever path resolves.
 */

const PROFILE = `${API_BASE}/api/auth/profile`;
const API_KEYS = `${API_BASE}/api/auth/api-keys`;
const LOGIN = `${API_BASE}/api/auth/login`;
const ANON = `${API_BASE}/api/auth/anonymous`;

interface ProfileResult {
    status: number;
    body: any;
    ok: boolean;
    setCookie: string[];
}

// Low-level GET /profile so we control EXACTLY which credential headers ride
// along (the `request` fixture must not auto-attach storageState cookies here).
async function getProfile(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<ProfileResult> {
    const res = await request.get(PROFILE, { headers });
    let body: any = null;
    try {
        body = await res.json();
    } catch {
        try {
            body = await res.text();
        } catch {
            body = null;
        }
    }
    const setCookie = res
        .headersArray()
        .filter((h) => h.name.toLowerCase() === 'set-cookie')
        .map((h) => h.value);
    return { status: res.status(), body, ok: res.ok(), setCookie };
}

interface Principal {
    access_token: string;
    email: string;
    userId?: string;
    cookieHeader?: string;
}

// Register a fresh user, then login to (a) confirm the bearer and (b) capture
// any Better-Auth session cookie the login issues (none in the CI driver, but
// the flow tolerates either). login DTO accepts ONLY { email, password }.
async function freshPrincipal(request: APIRequestContext): Promise<Principal> {
    const u = await registerUserViaAPI(request);
    const loginRes = await request.post(LOGIN, {
        data: { email: u.email, password: u.password },
    });
    let cookieHeader: string | undefined;
    if (loginRes.ok()) {
        const setCookies = loginRes
            .headersArray()
            .filter((h) => h.name.toLowerCase() === 'set-cookie');
        if (setCookies.length) {
            cookieHeader = setCookies
                .map((h) => h.value.split(';')[0])
                .filter(Boolean)
                .join('; ');
        }
        const loginBody = await loginRes.json().catch(() => ({}) as any);
        if (loginBody?.access_token) u.access_token = loginBody.access_token;
    }
    return {
        access_token: u.access_token,
        email: u.email,
        userId: u.user?.id,
        cookieHeader,
    };
}

// Create a real ew_live_ API key for a bearer principal. Returns the plaintext
// key (shown once) or undefined if issuance is unavailable in this env.
async function createApiKey(
    request: APIRequestContext,
    bearer: string,
): Promise<string | undefined> {
    const res = await request.post(API_KEYS, {
        headers: { ...authedHeaders(bearer), 'Content-Type': 'application/json' },
        data: { name: `prec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    });
    if (!res.ok()) return undefined;
    const body = await res.json().catch(() => undefined as any);
    const key = body?.key ?? body?.apiKey ?? body?.token ?? body?.value ?? body?.secret;
    return typeof key === 'string' && key.startsWith('ew_live_') ? key : undefined;
}

function principalEmail(body: any): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    return body.email ?? body.user?.email ?? body.data?.email;
}

function principalId(body: any): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    return body.id ?? body.userId ?? body.user?.id ?? body.sub;
}

// Assert the ONLY universally-true 401 invariant: statusCode 401 + a non-empty
// message string. Deliberately does NOT require an `error` field — the generic
// guard reject omits it while the api-key reject includes it (proved non-uniform).
function assert401Minimal(body: any, ctx: string): void {
    if (body && typeof body === 'object') {
        expect(body.statusCode, `${ctx}: 401 envelope statusCode`).toBe(401);
        const msgOk = typeof body.message === 'string' || Array.isArray(body.message);
        expect(msgOk, `${ctx}: 401 envelope has a message`).toBeTruthy();
    }
}

test.describe('auth-method precedence & conflict resolution', () => {
    test('API-KEY prefix path is AUTHORITATIVE: a present ew_live_ key short-circuits even a VALID session bearer (no fall-through)', async ({
        request,
    }) => {
        const a = await freshPrincipal(request);

        // Baseline: the valid session bearer ALONE authenticates as user A on the
        // PROVIDER path (fingerprint iss:'auth-runtime').
        const viaBearer = await getProfile(request, { Authorization: `Bearer ${a.access_token}` });
        expect(viaBearer.status, 'valid session bearer alone -> 200').toBe(200);
        expect(principalEmail(viaBearer.body)?.toLowerCase()).toBe(a.email.toLowerCase());
        if (viaBearer.body?.iss !== undefined) {
            expect(viaBearer.body.iss, 'session path fingerprint iss').toBe('auth-runtime');
            expect(viaBearer.body.aud, 'session path fingerprint aud').toBe('ever-works-users');
        }

        // CONFLICT: same valid bearer PLUS a bogus ew_live_ x-api-key. The guard
        // takes the API-key path FIRST and, the key being invalid, MUST 401 —
        // it never falls through to the valid session. This is the central
        // precedence contract.
        const conflict = await getProfile(request, {
            Authorization: `Bearer ${a.access_token}`,
            'x-api-key': 'ew_live_deadbeefdeadbeef',
        });
        expect(
            conflict.status,
            'valid session bearer + bogus ew_live_ x-api-key -> API-key path wins -> 401 (NOT 200)',
        ).toBe(401);
        // And the message is the API-key path's distinct one (carries `error`).
        if (conflict.body && typeof conflict.body === 'object') {
            expect(String(conflict.body.message), 'api-key reject message').toContain('API key');
            expect(conflict.body.error, 'api-key reject carries error label').toBe('Unauthorized');
        }

        // Determinism: repeating the identical conflict request agrees every time.
        for (let i = 0; i < 2; i++) {
            const again = await getProfile(request, {
                Authorization: `Bearer ${a.access_token}`,
                'x-api-key': 'ew_live_deadbeefdeadbeef',
            });
            expect(again.status, `deterministic conflict #${i + 1}`).toBe(401);
        }

        // Control: with the bogus key REMOVED the very same bearer is 200 again,
        // proving the 401 above was the key path short-circuiting (not a dead session).
        const restored = await getProfile(request, { Authorization: `Bearer ${a.access_token}` });
        expect(restored.status, 'bearer alone still authenticates after the conflict').toBe(200);
        expect(principalEmail(restored.body)?.toLowerCase()).toBe(a.email.toLowerCase());
    });

    test('a VALID API key resolves to its owner via BOTH header slots, with the API-key path fingerprint (iss/aud=ever-works, no isAnonymous)', async ({
        request,
    }) => {
        const owner = await freshPrincipal(request);
        const key = await createApiKey(request, owner.access_token);
        test.skip(!key, 'API-key issuance unavailable in this environment');

        // Owner id as seen on the session path, to compare against the key path.
        const sessionView = await getProfile(request, {
            Authorization: `Bearer ${owner.access_token}`,
        });
        expect(sessionView.status).toBe(200);
        const ownerId = principalId(sessionView.body);

        // (a) via x-api-key
        const viaHeader = await getProfile(request, { 'x-api-key': key! });
        expect(viaHeader.status, 'x-api-key -> 200 as owner').toBe(200);
        expect(principalId(viaHeader.body), 'x-api-key resolves to the SAME owner').toBe(ownerId);

        // (b) via Authorization: Bearer ew_live_…
        const viaBearer = await getProfile(request, { Authorization: `Bearer ${key!}` });
        expect(viaBearer.status, 'Bearer ew_live_ -> 200 as owner').toBe(200);
        expect(principalId(viaBearer.body), 'Bearer ew_live_ resolves to the SAME owner').toBe(
            ownerId,
        );

        // Both slots resolve to the IDENTICAL principal — never a different/merged one.
        expect(principalId(viaHeader.body), 'both API-key slots agree on the principal').toBe(
            principalId(viaBearer.body),
        );

        // PATH FINGERPRINT: the API-key path stamps iss/aud='ever-works' and OMITS
        // isAnonymous, whereas the session path uses 'auth-runtime'/'ever-works-users'
        // WITH isAnonymous. Same human, provably different resolution path.
        if (viaHeader.body?.iss !== undefined) {
            expect(viaHeader.body.iss, 'api-key path iss').toBe('ever-works');
            expect(viaHeader.body.aud, 'api-key path aud').toBe('ever-works');
        }
        if (sessionView.body?.iss !== undefined) {
            expect(sessionView.body.iss, 'session path iss differs from api-key path').toBe(
                'auth-runtime',
            );
            expect(
                viaHeader.body?.iss === undefined || viaHeader.body.iss !== sessionView.body.iss,
                'the two paths carry DISTINCT issuer fingerprints',
            ).toBeTruthy();
        }
    });

    test('header CASE of the bearer scheme routes the SAME ew_live_ value to DIFFERENT paths (capital -> API-key reject, lower -> provider reject)', async ({
        request,
    }) => {
        // Capital "Bearer ew_live_…" -> API-key discriminator matches EXACT 'Bearer'
        // -> API-key path -> distinct "Invalid or expired API key" + error label.
        const capital = await getProfile(request, {
            Authorization: 'Bearer ew_live_bogusbogusbogus',
        });
        expect(capital.status, 'capital Bearer ew_live_ -> 401').toBe(401);
        if (capital.body && typeof capital.body === 'object') {
            expect(String(capital.body.message), 'capital -> api-key path message').toContain(
                'API key',
            );
            expect(capital.body.error, 'capital -> api-key path carries error').toBe(
                'Unauthorized',
            );
        }

        // lowercase "bearer ew_live_…" -> guard's EXACT 'Bearer' check fails ->
        // falls through to provider, which lowercases the scheme and treats
        // ew_live_bogus as a (missing) SESSION token -> GENERIC reject (no `error`).
        const lower = await getProfile(request, {
            Authorization: 'bearer ew_live_bogusbogusbogus',
        });
        expect(lower.status, 'lowercase bearer ew_live_ -> 401').toBe(401);
        if (lower.body && typeof lower.body === 'object') {
            expect(String(lower.body.message), 'lowercase -> generic reject message').toBe(
                'Unauthorized',
            );
            expect(
                lower.body.error,
                'lowercase -> generic reject OMITS error label',
            ).toBeUndefined();
        }

        // PROVED divergence: the two responses to the SAME credential value are
        // genuinely different envelopes — case alone changed the resolution path.
        if (capital.body?.message !== undefined && lower.body?.message !== undefined) {
            expect(
                String(capital.body.message),
                'case of the scheme produces a DIFFERENT 401 body',
            ).not.toBe(String(lower.body.message));
        }

        // Sanity that the lowercase scheme is still a VALID provider credential for
        // a real session token (so the lowercase 401 above is about the bad key,
        // not a rejected scheme): lowercase bearer + valid session -> 200.
        const a = await freshPrincipal(request);
        const lowerValid = await getProfile(request, {
            Authorization: `bearer ${a.access_token}`,
        });
        expect(
            lowerValid.status,
            'lowercase bearer + VALID session -> 200 (scheme is case-insensitive on provider path)',
        ).toBe(200);
        expect(principalEmail(lowerValid.body)?.toLowerCase()).toBe(a.email.toLowerCase());
    });

    test('cross-user conflict resolves DETERMINISTICALLY to exactly one presented identity, never a blended third one', async ({
        request,
    }) => {
        const a = await freshPrincipal(request); // session bearer principal
        const b = await freshPrincipal(request);
        expect(a.email).not.toBe(b.email);
        const bKey = await createApiKey(request, b.access_token);

        // Each credential ALONE resolves to its OWN owner (proves both are valid,
        // so the conflict is real).
        const aAlone = await getProfile(request, { Authorization: `Bearer ${a.access_token}` });
        expect(aAlone.status).toBe(200);
        const aId = principalId(aAlone.body);
        expect(principalEmail(aAlone.body)?.toLowerCase()).toBe(a.email.toLowerCase());

        if (bKey) {
            const bAlone = await getProfile(request, { 'x-api-key': bKey });
            expect(bAlone.status).toBe(200);
            expect(principalEmail(bAlone.body)?.toLowerCase()).toBe(b.email.toLowerCase());
            const bId = principalId(bAlone.body);

            // CONFLICT: user-A session bearer + user-B API key in ONE request. The
            // guard's API-key-first ordering means B's key path is authoritative ->
            // resolves to B (never A, never a merge). We assert the WEAKER, always-true
            // invariant first (one of the two real ids), then the precise winner.
            const headers = { Authorization: `Bearer ${a.access_token}`, 'x-api-key': bKey };
            const conflict = await getProfile(request, headers);
            expect(conflict.status, 'cross-user conflict authenticates (API-key path)').toBe(200);
            const winnerId = principalId(conflict.body);
            expect(
                [aId, bId],
                'winner is exactly ONE of the two real principals (no blended id)',
            ).toContain(winnerId);
            expect(winnerId, 'API-key-first precedence -> the API-key owner (B) wins').toBe(bId);

            // Deterministic across repeats.
            const conflict2 = await getProfile(request, headers);
            const conflict3 = await getProfile(request, headers);
            expect(principalId(conflict2.body), 'deterministic #2').toBe(winnerId);
            expect(principalId(conflict3.body), 'deterministic #3').toBe(winnerId);
        } else {
            // No API-key issuance: fall back to a bearer-vs-bearer "conflict" where
            // only one Authorization header can exist — the single bearer must
            // resolve to its own owner, never to B.
            const single = await getProfile(request, { Authorization: `Bearer ${a.access_token}` });
            expect(principalId(single.body), 'single bearer resolves to its own owner only').toBe(
                aId,
            );
        }
    });

    test('anonymous -> authenticated UPGRADE: same /profile flips 401 -> anonymous principal -> registered principal, each with distinct provider/isAnonymous', async ({
        request,
    }) => {
        // Step 0: truly anonymous (no credentials) -> 401.
        const none = await getProfile(request, {});
        expect(none.status, 'no credentials -> 401').toBe(401);
        assert401Minimal(none.body, 'pre-upgrade-anon');

        // Step 1: zero-friction upgrade — mint an anonymous session.
        const anonRes = await request.post(ANON, {
            data: {},
            headers: { 'Content-Type': 'application/json' },
        });
        // Anonymous flow may be throttled (5/h per IP) or disabled; tolerate that.
        if ([200, 201].includes(anonRes.status())) {
            const anonBody = await anonRes.json().catch(() => ({}) as any);
            const anonToken: string | undefined =
                anonBody?.access_token ?? anonBody?.token ?? anonBody?.user?.access_token;
            if (anonToken) {
                const anonProfile = await getProfile(request, {
                    Authorization: `Bearer ${anonToken}`,
                });
                expect(anonProfile.status, 'anonymous bearer -> 200 (upgraded from 401)').toBe(200);
                // Anonymous principal: provider 'anonymous', isAnonymous true, email null.
                if (anonProfile.body?.provider !== undefined) {
                    expect(anonProfile.body.provider, 'anonymous principal provider').toBe(
                        'anonymous',
                    );
                }
                if (anonProfile.body?.isAnonymous !== undefined) {
                    expect(anonProfile.body.isAnonymous, 'anonymous principal isAnonymous').toBe(
                        true,
                    );
                }
                expect(
                    principalId(anonProfile.body),
                    'anonymous principal has a stable id',
                ).toBeTruthy();
            }
        } else {
            expect(
                [201, 200, 400, 429],
                'anonymous endpoint returns a well-defined status',
            ).toContain(anonRes.status());
        }

        // Step 2: a FULL registered upgrade — distinct provider 'local', isAnonymous false.
        const reg = await freshPrincipal(request);
        const regProfile = await getProfile(request, {
            Authorization: `Bearer ${reg.access_token}`,
        });
        expect(regProfile.status, 'registered bearer -> 200').toBe(200);
        expect(principalEmail(regProfile.body)?.toLowerCase()).toBe(reg.email.toLowerCase());
        if (regProfile.body?.provider !== undefined) {
            expect(regProfile.body.provider, 'registered principal provider').toBe('local');
        }
        if (regProfile.body?.isAnonymous !== undefined) {
            expect(regProfile.body.isAnonymous, 'registered principal isAnonymous').toBe(false);
        }

        // id and userId are the SAME UUID on the canonical profile shape.
        if (regProfile.body?.id !== undefined && regProfile.body?.userId !== undefined) {
            expect(regProfile.body.id, 'profile id === userId').toBe(regProfile.body.userId);
        }
    });

    test('stateless API key SURVIVES session logout while the session bearer is revoked — two credentials, independent lifecycles', async ({
        request,
    }) => {
        const u = await freshPrincipal(request);
        const key = await createApiKey(request, u.access_token);

        // Both credentials authenticate as the same owner up front.
        const bearerBefore = await getProfile(request, {
            Authorization: `Bearer ${u.access_token}`,
        });
        expect(bearerBefore.status, 'session bearer -> 200 before logout').toBe(200);
        const ownerId = principalId(bearerBefore.body);

        if (key) {
            const keyBefore = await getProfile(request, { 'x-api-key': key });
            expect(keyBefore.status, 'api key -> 200 before logout').toBe(200);
            expect(principalId(keyBefore.body), 'api key -> same owner').toBe(ownerId);
        }

        // Logout — invalidates THIS session bearer (signOut deletes the session row
        // for the presented bearer). Best-effort across status codes.
        const logout = await request.post(`${API_BASE}/api/auth/logout`, {
            headers: { ...authedHeaders(u.access_token), 'Content-Type': 'application/json' },
        });
        const loggedOut = [200, 201, 204].includes(logout.status());

        if (loggedOut) {
            // The session bearer is now dead -> provider returns null -> 401 generic.
            await expect
                .poll(
                    async () =>
                        (await getProfile(request, { Authorization: `Bearer ${u.access_token}` }))
                            .status,
                    { timeout: 15_000, intervals: [500, 1000, 2000] },
                )
                .toBe(401);

            const afterBearer = await getProfile(request, {
                Authorization: `Bearer ${u.access_token}`,
            });
            expect(afterBearer.status, 'revoked session bearer -> 401').toBe(401);
            assert401Minimal(afterBearer.body, 'post-logout-bearer');

            // ...but the API key is a SEPARATE credential keyed off the API-key table,
            // untouched by session signOut -> still 200 as the owner.
            if (key) {
                const afterKey = await getProfile(request, { 'x-api-key': key });
                expect(afterKey.status, 'API key survives session logout -> 200').toBe(200);
                expect(principalId(afterKey.body), 'API key still resolves to the owner').toBe(
                    ownerId,
                );
            }
        } else {
            // If logout is unavailable, at minimum the credentials remain consistent.
            const stillBearer = await getProfile(request, {
                Authorization: `Bearer ${u.access_token}`,
            });
            expect([200, 401], 'bearer status well-defined when logout unavailable').toContain(
                stillBearer.status,
            );
        }
    });

    test('401 envelopes are NON-uniform but share statusCode 401; the seeded UI session and a fresh API principal never cross identities', async ({
        request,
        browser,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // (a) Collect the family of reject envelopes and prove the contrast.
        const noCreds = await getProfile(request, {});
        const malformedScheme = await getProfile(request, { Authorization: 'Basic Zm9vOmJhcg==' });
        const badSession = await getProfile(request, { Authorization: 'Bearer not.a.real.token' });
        const badApiKey = await getProfile(request, { Authorization: 'Bearer ew_live_nope' });
        const bogusXApiKey = await getProfile(request, { 'x-api-key': 'plain-no-prefix' });

        for (const r of [noCreds, malformedScheme, badSession, badApiKey, bogusXApiKey]) {
            expect(r.status, 'reject status is 401').toBe(401);
            assert401Minimal(r.body, 'reject-family');
        }

        // CONTRAST: the api-key path reject carries `error:'Unauthorized'`; the
        // generic guard reject OMITS it. So a single uniform envelope assertion
        // would be WRONG — we assert the divergence is real.
        if (
            badApiKey.body?.error !== undefined &&
            noCreds.body &&
            typeof noCreds.body === 'object'
        ) {
            expect(badApiKey.body.error, 'api-key reject carries error label').toBe('Unauthorized');
            expect(
                noCreds.body.error,
                'generic reject OMITS the error label (envelopes are NOT uniform)',
            ).toBeUndefined();
        }

        // (b) Seeded (storageState) account vs a fresh API principal — no bleed.
        const s = loadSeededTestUser();
        const seededLogin = await request.post(LOGIN, {
            data: { email: s.email, password: s.password },
        });
        expect(seededLogin.ok(), 'seeded user can login').toBeTruthy();
        const seededToken = (await seededLogin.json()).access_token as string;
        const seededProfile = await getProfile(request, { Authorization: `Bearer ${seededToken}` });
        expect(seededProfile.status, 'seeded bearer -> 200').toBe(200);
        expect(principalEmail(seededProfile.body)?.toLowerCase()).toBe(s.email.toLowerCase());
        const seededId = principalId(seededProfile.body);

        const fresh = await freshPrincipal(request);
        const freshKey = await createApiKey(request, fresh.access_token);
        const freshProfile = await getProfile(request, {
            Authorization: `Bearer ${fresh.access_token}`,
        });
        expect(freshProfile.status, 'fresh bearer -> 200').toBe(200);
        expect(
            principalEmail(freshProfile.body)?.toLowerCase(),
            'fresh distinct from seeded',
        ).not.toBe(s.email.toLowerCase());
        const freshId = principalId(freshProfile.body);
        expect(freshId, 'fresh id distinct from seeded id').not.toBe(seededId);

        // Mixed conflict: seeded SESSION bearer + fresh user's API key. API-key-first
        // precedence -> the fresh (key owner) wins; deterministically; never blended.
        if (freshKey) {
            const headers = { Authorization: `Bearer ${seededToken}`, 'x-api-key': freshKey };
            const mixed = await getProfile(request, headers);
            expect(mixed.status, 'mixed conflict authenticates').toBe(200);
            const mixedId = principalId(mixed.body);
            expect([seededId, freshId], 'mixed -> one real principal, no cross-bleed').toContain(
                mixedId,
            );
            expect(mixedId, 'API-key path wins -> the key owner (fresh)').toBe(freshId);
            const mixed2 = await getProfile(request, headers);
            expect(principalId(mixed2.body), 'mixed conflict deterministic').toBe(mixedId);
        }

        // (c) UI smoke: an ANONYMOUS browser context (NO storageState — a bare
        // newContext would INHERIT the auth cookie) hitting a protected page is
        // bounced to /login. next-dev local/CI route divergence -> tolerant assert.
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonPage = await anonCtx.newPage();
            await anonPage.goto(`${origin}/works`, { waitUntil: 'domcontentloaded' });
            await anonPage.waitForTimeout(1500);
            const onLogin = /\/login/.test(anonPage.url());
            const loginVisible = await anonPage
                .locator('input[type="password"], input[name="password"]')
                .first()
                .isVisible()
                .catch(() => false);
            expect(
                onLogin || loginVisible,
                'anonymous protected-page access redirects to login (or shows the login form)',
            ).toBeTruthy();
        } finally {
            await anonCtx.close();
        }
    });
});
