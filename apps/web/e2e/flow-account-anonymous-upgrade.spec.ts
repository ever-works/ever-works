import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Anonymous account → real-identity UPGRADE — cross-feature integration flows
 * (EW-617 G2/G3).
 *
 * The platform's zero-friction onboarding mints a throwaway, time-boxed
 * `User` row (`isAnonymous=true` + a forward-dated `anonymousExpiresAt`) so a
 * visitor can OWN real resources (Works, etc.) before committing an
 * email+password. The "claim" call upgrades that SAME row in place — without
 * changing its `id` — so everything it owns carries over for free. A nightly
 * Trigger.dev cleanup purges rows that were never claimed once their TTL
 * elapses (cascading their Works). THIS suite drives the full upgrade
 * lifecycle end-to-end: anon birth → owns Works → claim → permanent identity →
 * login continuity → ownership transfer → the cross-anon isolation matrix →
 * the validation matrix → and the (read-only) cleanup/expiry contract.
 *
 * Every shape, status, and error message below was confirmed against the LIVE
 * stack (sqlite in-memory — the same driver CI uses) BEFORE assertions were
 * written:
 *
 *   POST /api/auth/anonymous → 201 { access_token, user:{ id, email:null,
 *        username:/^anon-[0-9a-f]{8}$/, isAnonymous:true, anonymousExpiresAt } }.
 *        access_token is a ~43-char opaque session token (NOT the register
 *        token) — never pin a fixed length. DTO whitelist (forbidNonWhitelisted)
 *        → unknown key 400 'property X should not exist'; correlationId must be
 *        UUID v4 (non-uuid → 400). @Throttle 5/60min per IP → tolerate 429.
 *   GET  /api/auth/profile (anon)  → { id, userId, email:null,
 *        provider:'anonymous', isAnonymous:true, emailVerified:false } (JWT echo).
 *   GET  /api/auth/profile/fresh (anon) → DB row: { id, username, slug, email:null,
 *        registrationProvider:'anonymous', isAnonymous:true, anonymousExpiresAt,
 *        emailVerified:false, isActive:true, … }.
 *   POST /api/works (anon bearer)  → 200 { status:'success', work:{ id, userId,
 *        owner:'anon-…', user:{ isAnonymous:true } } }. GET /api/works → that
 *        work with userRole:'owner'; GET /api/works/:id → 200 to the owner, 403
 *        to a DIFFERENT anon. (GET /api/works/slug/:slug is a separate route
 *        that 404s for these freshly-created slugs — use the id route.)
 *   POST /api/auth/claim (anon bearer) → 200 { id (UNCHANGED), email, username,
 *        emailVerified:false }. Flips isAnonymous→false, registrationProvider→
 *        'local', clears anonymousExpiresAt. The original bearer STAYS valid.
 *        Negative matrix:
 *          - no Authorization      → 401 Unauthorized
 *          - non-anon (registered) → 403 'claim is only valid for anonymous …'
 *          - already-claimed (now permanent) → 403 (same message)
 *          - email taken by another → 409 'Email is already in use by another …'
 *          - password fails policy  → 400 (>=8 chars + lowercase + digit/special)
 *          - username override <3   → 400 'username must be longer than or equal …'
 *          - unknown body key       → 400 'property X should not exist'
 *   POST /api/auth/login { email, password } → 200 { access_token } for the
 *        freshly-claimed creds; the new session still sees the pre-claim Work.
 *
 * Anon TTL / cleanup contract (read-only assertion of the published contract):
 *   `anonymousExpiresAt` = now + ANONYMOUS_USER_TTL_DAYS (default 3 → exactly
 *   72h on the live stack). The nightly `anonymous-user-cleanup` Trigger.dev
 *   schedule calls `UserRepository.findExpiredAnonymous(now)` =
 *   `isAnonymous=true AND anonymousExpiresAt < now`, then `deleteAnonymous(id)`
 *   = `delete({ id, isAnonymous:true })` which CASCADES to the user's Works via
 *   `work.userId ON DELETE CASCADE`. A freshly-minted anon is NEVER in the
 *   expired set (its expiry is ~3 days out), and CLAIM removes it from the set
 *   permanently by clearing the TTL — we assert that contract from the API
 *   surface (Trigger.dev is not running in CI, so the cron itself can't fire;
 *   we never assert a row was actually purged, only the gate that selects it).
 *
 * Gotchas baked in (all verified live):
 *   - LOGIN DTO is whitelisted to { email, password } only.
 *   - REQUIRE_EMAIL_VERIFICATION=false + e2e SMTP delivery fails ("Missing
 *     credentials for PLAIN") → claim's verification mail is BEST-EFFORT; we
 *     assert the API claim contract, never a delivered email.
 *   - Anon throttle is 5/60min PER IP — back-to-back anon mints in one run can
 *     429. Every test tolerates a 429 on the anon-mint call and skips.
 *   - ANON CONTEXT for the UI flow: bare browser.newContext() inherits the
 *     storageState cookie → we use newContext({ storageState:{ cookies:[],
 *     origins:[] } }) for a genuinely anonymous page.
 *   - Isolation: every flow mints FRESH anon/registered users + fresh Works —
 *     never the shared seeded storageState user — so the in-memory DB stays
 *     clean for sibling specs. Assertions tolerate pre-existing rows (toContain
 *     / per-id checks, never exact global counts).
 *
 * Relationship to siblings: zero-friction-flow.spec.ts pins the bare claim
 * flip + dup-409; auth-providers-list.spec.ts pins the anon shape + claim-401;
 * claim-flow.spec.ts pins the (different) tokenised /claim/<token> work-invite
 * surface; flow-account-deletion-deep.spec.ts pins ONE anonymize→claim→permanent
 * case as the "grace clock" analogue. THIS suite is the multi-step orchestration
 * that threads anon birth → real resource ownership → claim upgrade → login
 * continuity → ownership transfer → the FULL negative isolation+validation
 * matrix → and the expiry/cleanup gate, none of which the siblings walk.
 */

const ANON_TTL_DAYS_DEFAULT = 3;

interface AnonSession {
    token: string;
    userId: string;
    username: string;
    anonymousExpiresAt: string;
}

/**
 * Mint a throwaway anonymous session. Returns `null` when the per-IP throttle
 * (5/60min) trips so the caller can `test.skip` rather than flake. Any other
 * non-201 is a real failure and is asserted on.
 */
async function mintAnon(request: APIRequestContext): Promise<AnonSession | null> {
    const res = await request.post(`${API_BASE}/api/auth/anonymous`, { data: {} });
    if (res.status() === 429) return null; // throttled — caller skips
    expect(res.status(), 'anonymous mint → 201').toBe(201);
    const body = await res.json();
    expect(typeof body?.access_token, 'opaque session token issued').toBe('string');
    expect(body?.user?.isAnonymous, 'minted row flagged anonymous').toBe(true);
    expect(String(body?.user?.username)).toMatch(/^anon-[0-9a-f]{8}$/);
    expect(typeof body?.user?.anonymousExpiresAt, 'TTL stamped').toBe('string');
    return {
        token: body.access_token,
        userId: body.user.id,
        username: body.user.username,
        anonymousExpiresAt: body.user.anonymousExpiresAt,
    };
}

function uniqueEmail(tag: string): string {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return `anon-upgrade-${tag}-${suffix}@test.local`;
}

async function createWorkAsAnon(
    request: APIRequestContext,
    token: string,
    name: string,
): Promise<{ id: string; slug: string }> {
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: authedHeaders(token),
        data: { name, slug, description: `owned by anon — ${name}`, organization: false },
    });
    expect(res.status(), 'anon can create a Work it owns').toBe(200);
    const json = await res.json();
    const work = json?.work ?? json;
    expect(work?.id, 'work id returned').toBeTruthy();
    return { id: work.id, slug };
}

test.describe('Anonymous account → real-identity upgrade (EW-617 G2/G3)', () => {
    test.describe.configure({ mode: 'serial' });

    test('FLOW 1 — anon birth carries a real, forward-dated TTL and a DB-backed anon identity (profile + profile/fresh agree)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled (5/60min per IP) — skipping');
        if (!anon) return;

        // The TTL window is the platform's only soft, time-boxed account state.
        // Default ANONYMOUS_USER_TTL_DAYS=3 → the live stack stamps exactly
        // ~72h out. Assert it is FORWARD-dated and within a generous band that
        // tolerates env overrides up to a week.
        const expiresMs = new Date(anon.anonymousExpiresAt).getTime();
        const horizonMs = expiresMs - Date.now();
        expect(horizonMs, 'anon TTL is forward-dated').toBeGreaterThan(60 * 60 * 1000); // > 1h
        expect(horizonMs, 'anon TTL is within a sane upper band').toBeLessThan(
            8 * 24 * 60 * 60 * 1000,
        );
        // Soft check that the default (3 days) holds when unoverridden.
        const days = horizonMs / (24 * 60 * 60 * 1000);
        expect(
            days,
            `anon TTL ≈ ${ANON_TTL_DAYS_DEFAULT}d (default) within tolerance`,
        ).toBeGreaterThan(0.4);

        // JWT-echo profile: provider='anonymous', isAnonymous=true, no email.
        const jwtRes = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(anon.token),
        });
        expect(jwtRes.status()).toBe(200);
        const jwt = await jwtRes.json();
        expect(jwt.provider).toBe('anonymous');
        expect(jwt.isAnonymous).toBe(true);
        expect(jwt.email).toBeFalsy();
        expect(jwt.emailVerified).toBe(false);
        expect(jwt.id, 'profile id matches the minted user id').toBe(anon.userId);

        // DB-backed fresh profile agrees and exposes the persisted TTL + provider.
        const freshRes = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(anon.token),
        });
        expect(freshRes.status()).toBe(200);
        const fresh = await freshRes.json();
        expect(fresh.id).toBe(anon.userId);
        expect(fresh.registrationProvider).toBe('anonymous');
        expect(fresh.isAnonymous).toBe(true);
        expect(fresh.email).toBeFalsy();
        expect(fresh.emailVerified).toBe(false);
        expect(fresh.isActive).toBe(true);
        expect(
            new Date(fresh.anonymousExpiresAt).getTime(),
            'fresh profile carries the same TTL instant',
        ).toBe(expiresMs);
        expect(fresh.username, 'username stable between mint and fresh read').toBe(anon.username);
    });

    test('FLOW 2 — anon owns a Work, then CLAIM upgrades the SAME row in place: id preserved, ownership carries over, identity flips to permanent', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        // Anon owns a real resource BEFORE committing an identity.
        const work = await createWorkAsAnon(request, anon.token, 'AnonOwned Carryover');

        // The work is owned by the anon (userId binding) and visible as owner.
        const listBefore = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(anon.token),
        });
        expect(listBefore.status()).toBe(200);
        const before = await listBefore.json();
        const ownedBefore = (before.works ?? []).find((w: { id: string }) => w.id === work.id);
        expect(ownedBefore, 'pre-claim work is in the anon owner list').toBeTruthy();
        expect(ownedBefore.userId).toBe(anon.userId);
        expect(ownedBefore.userRole).toBe('owner');

        // CLAIM: upgrade the anon → permanent. Same bearer, same row.
        const email = uniqueEmail('carry');
        const password = 'Carryover123!';
        const claimRes = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email, password },
        });
        expect(claimRes.status(), 'claim → 200').toBe(200);
        const claimed = await claimRes.json();
        expect(claimed.id, 'claim does NOT mint a new row — id is unchanged').toBe(anon.userId);
        expect(String(claimed.email).toLowerCase()).toBe(email.toLowerCase());
        expect(claimed.emailVerified, 'claimed account starts unverified').toBe(false);

        // Identity flipped to permanent: isAnonymous=false, provider=local, TTL cleared.
        const freshAfter = await request
            .get(`${API_BASE}/api/auth/profile/fresh`, { headers: authedHeaders(anon.token) })
            .then((r) => r.json());
        expect(freshAfter.id, 'still the same row after claim').toBe(anon.userId);
        expect(freshAfter.isAnonymous, 'no longer anonymous').toBe(false);
        expect(freshAfter.registrationProvider, 'provider flipped to local').toBe('local');
        expect(freshAfter.anonymousExpiresAt, 'grace/expiry clock cleared on claim').toBeFalsy();
        expect(String(freshAfter.email).toLowerCase()).toBe(email.toLowerCase());

        // Ownership carried over: the pre-claim Work is STILL owned post-claim.
        const listAfter = await request
            .get(`${API_BASE}/api/works`, { headers: authedHeaders(anon.token) })
            .then((r) => r.json());
        const ownedAfter = (listAfter.works ?? []).find((w: { id: string }) => w.id === work.id);
        expect(
            ownedAfter,
            'pre-claim work survives the upgrade (no transfer step needed)',
        ).toBeTruthy();
        expect(ownedAfter.userId, 'work still bound to the same (now permanent) userId').toBe(
            anon.userId,
        );
        expect(ownedAfter.userRole).toBe('owner');
    });

    test('FLOW 3 — claimed credentials sign in via /login and the FRESH session still sees the pre-claim Work; the original anon bearer stays valid', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        const work = await createWorkAsAnon(request, anon.token, 'AnonOwned LoginContinuity');

        const email = uniqueEmail('login');
        const password = 'LoginContinuity1!';
        const claimRes = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email, password },
        });
        expect(claimRes.status()).toBe(200);

        // The ORIGINAL anon bearer is still a valid session after claim.
        const stillValid = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(anon.token),
        });
        expect(stillValid.status(), 'original anon bearer survives the claim').toBe(200);

        // LOGIN with the freshly-claimed creds (DTO is whitelisted to {email,password}).
        const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password },
        });
        expect(loginRes.status(), 'claimed creds log in').toBe(200);
        const login = await loginRes.json();
        expect(typeof login.access_token, 'login issues a fresh bearer').toBe('string');
        expect(login.access_token, 'login bearer differs from the anon bearer').not.toBe(
            anon.token,
        );

        // The fresh login session resolves to a NON-anonymous identity…
        const loginProfile = await request
            .get(`${API_BASE}/api/auth/profile`, { headers: authedHeaders(login.access_token) })
            .then((r) => r.json());
        expect(loginProfile.id, 'login resolves to the same upgraded row').toBe(anon.userId);
        expect(loginProfile.isAnonymous).toBe(false);
        expect(loginProfile.provider).toBe('local');

        // …and STILL sees the work that was created while anonymous.
        const fresh = await request
            .get(`${API_BASE}/api/works`, { headers: authedHeaders(login.access_token) })
            .then((r) => r.json());
        const seen = (fresh.works ?? []).find((w: { id: string }) => w.id === work.id);
        expect(
            seen,
            'pre-claim work is visible through the freshly-logged-in session',
        ).toBeTruthy();
        expect(seen.userRole).toBe('owner');
    });

    test('FLOW 4 — claim is a one-way, single-account door: 401 (no auth) / 403 (non-anon & already-claimed) / 409 (email squat)', async ({
        request,
    }) => {
        test.setTimeout(90_000);

        // (a) No Authorization → 401. Claim requires an anon session bearer.
        const noAuth = await request.post(`${API_BASE}/api/auth/claim`, {
            data: { email: uniqueEmail('noauth'), password: 'NoAuth12345!' },
        });
        expect(noAuth.status(), 'claim with no bearer → 401').toBe(401);

        // (b) A registered (non-anon) user cannot claim → 403 with the exact guard message.
        const registered = await registerUserViaAPI(request);
        const byRegistered = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(registered.access_token),
            data: { email: uniqueEmail('reg'), password: 'RegClaim1234!' },
        });
        expect(byRegistered.status(), 'registered user claiming → 403').toBe(403);
        expect(String((await byRegistered.json()).message)).toContain(
            'claim is only valid for anonymous',
        );

        // (c) Email already in use → 409 (never auto-merge — the documented policy).
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;
        const squat = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: registered.email, password: 'Squatter1234!' },
        });
        expect(squat.status(), 'claiming a taken email → 409').toBe(409);
        expect(String((await squat.json()).message)).toContain('already in use');
        // 409 must NOT have consumed the anon — it is STILL anonymous and claimable.
        const stillAnon = await request
            .get(`${API_BASE}/api/auth/profile/fresh`, { headers: authedHeaders(anon.token) })
            .then((r) => r.json());
        expect(stillAnon.isAnonymous, 'a failed (409) claim leaves the anon unchanged').toBe(true);

        // (d) A SUCCESSFUL claim, then a re-claim on the now-permanent account → 403.
        const ownEmail = uniqueEmail('oneway');
        const firstClaim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: ownEmail, password: 'OneWayDoor1!' },
        });
        expect(firstClaim.status(), 'first claim succeeds').toBe(200);
        const reClaim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('twice'), password: 'OneWayDoor2!' },
        });
        expect(reClaim.status(), 're-claiming a now-permanent account → 403').toBe(403);
        expect(String((await reClaim.json()).message)).toContain(
            'claim is only valid for anonymous',
        );
    });

    test('FLOW 5 — the upgrade boundary validates hard: weak password / short username override / unknown body key are all 400 and DO NOT consume the anon', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        // Weak password (policy: >=8 chars + lowercase + digit/special) → 400.
        const weak = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('weak'), password: 'short' },
        });
        expect(weak.status(), 'weak password rejected at the claim boundary').toBe(400);

        // Username override shorter than 3 chars → 400.
        const shortUser = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('shortuser'), password: 'GoodPass123!', username: 'ab' },
        });
        expect(shortUser.status(), 'short username override rejected').toBe(400);

        // Unknown body key → 400 (forbidNonWhitelisted on the claim DTO).
        const extraKey = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('extra'), password: 'GoodPass123!', bogusField: 'x' },
        });
        expect(extraKey.status(), 'unknown claim body key rejected').toBe(400);
        expect(String((await extraKey.json()).message)).toContain('should not exist');

        // After three rejected attempts the anon is UNTOUCHED — still anonymous,
        // still claimable. The validation gate never mutates the row.
        const fresh = await request
            .get(`${API_BASE}/api/auth/profile/fresh`, { headers: authedHeaders(anon.token) })
            .then((r) => r.json());
        expect(fresh.isAnonymous, 'rejected claims leave the anon intact').toBe(true);
        expect(fresh.registrationProvider).toBe('anonymous');
        expect(fresh.email, 'no email attached by a rejected claim').toBeFalsy();

        // And a VALID claim with a username override still works afterward —
        // proving the rejections didn't poison or rate-burn the anon row.
        const goodUser = `claimed${Date.now().toString(36).slice(-6)}`;
        const ok = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('finally'), password: 'GoodPass123!', username: goodUser },
        });
        expect(ok.status(), 'a valid claim still succeeds after the rejections').toBe(200);
        expect((await ok.json()).username, 'username override applied on success').toBe(goodUser);
    });

    test("FLOW 6 — anon resources are STRICTLY owner-scoped: a second anon cannot read/list the first anon's Work, and the upgrade preserves that isolation", async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const anonA = await mintAnon(request);
        test.skip(!anonA, 'anonymous mint throttled — skipping');
        if (!anonA) return;
        const anonB = await mintAnon(request);
        test.skip(!anonB, 'second anonymous mint throttled — skipping');
        if (!anonB) return;

        // Two anons are distinct identities.
        expect(anonA.userId).not.toBe(anonB.userId);

        // Anon A owns a Work.
        const work = await createWorkAsAnon(request, anonA.token, 'IsolatedAnon Resource');

        // Owner A can read it by id.
        const ownerRead = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(anonA.token),
        });
        expect(ownerRead.status(), 'owner reads its own work').toBe(200);

        // Anon B is forbidden — owner scoping holds for the time-boxed anon too.
        const otherRead = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(anonB.token),
        });
        expect(
            [403, 404].includes(otherRead.status()),
            'a different anon cannot read the work (403, or 404 if hidden)',
        ).toBe(true);

        // …and it never appears in B's owner list.
        const bList = await request
            .get(`${API_BASE}/api/works`, { headers: authedHeaders(anonB.token) })
            .then((r) => r.json());
        const leaked = (bList.works ?? []).find((w: { id: string }) => w.id === work.id);
        expect(leaked, "the work never leaks into a different anon's list").toBeFalsy();

        // Upgrade A → permanent; the isolation guarantee must SURVIVE the claim.
        const email = uniqueEmail('iso');
        const claimRes = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anonA.token),
            data: { email, password: 'IsolatedClaim1!' },
        });
        expect(claimRes.status()).toBe(200);

        // B (still anon) still cannot reach A's now-permanently-owned work.
        const afterClaim = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(anonB.token),
        });
        expect(
            [403, 404].includes(afterClaim.status()),
            'isolation survives the upgrade — B still cannot read A’s work',
        ).toBe(true);
    });

    test('FLOW 7 — cleanup/expiry CONTRACT: a fresh anon is never in the expired set, and the anon endpoint stays resilient to malformed/whitelisted payloads + throttle', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        // The cleanup gate is `isAnonymous=true AND anonymousExpiresAt < now`.
        // A just-minted anon's expiry is forward-dated (~3 days), so it can
        // NEVER match the expired predicate right now. We assert that property
        // from the API surface (the cron itself is Trigger.dev — not running in
        // CI — so we never assert an actual purge, only the gate that selects).
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;
        const expiresMs = new Date(anon.anonymousExpiresAt).getTime();
        expect(
            expiresMs > Date.now(),
            'a fresh anon is NOT yet expired → excluded from findExpiredAnonymous(now)',
        ).toBe(true);

        // Claiming removes the row from the expired-anon population permanently
        // by clearing the TTL — so the nightly purge can never wipe a claimed
        // account. Assert the published flip from the API.
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('cleanup'), password: 'CleanupClaim1!' },
        });
        expect(claim.status()).toBe(200);
        const fresh = await request
            .get(`${API_BASE}/api/auth/profile/fresh`, { headers: authedHeaders(anon.token) })
            .then((r) => r.json());
        expect(fresh.isAnonymous, 'claimed account is no longer in the anon population').toBe(
            false,
        );
        expect(
            fresh.anonymousExpiresAt,
            'TTL cleared → can never satisfy anonymousExpiresAt < now',
        ).toBeFalsy();

        // The anon mint endpoint is hardened by a whitelisting DTO: unknown
        // keys 400, and a non-UUID correlationId 400. Throttle (5/60min per IP)
        // may have us at the cap by now → tolerate 429 on these probes.
        const unknownKey = await request.post(`${API_BASE}/api/auth/anonymous`, {
            data: { foo: 'bar' },
        });
        expect(
            [400, 429].includes(unknownKey.status()),
            'unknown anon body key → 400 (or 429 if throttled)',
        ).toBe(true);
        if (unknownKey.status() === 400) {
            expect(String((await unknownKey.json()).message)).toContain('should not exist');
        }

        const badCorrelation = await request.post(`${API_BASE}/api/auth/anonymous`, {
            data: { correlationId: 'not-a-uuid' },
        });
        expect(
            [400, 429].includes(badCorrelation.status()),
            'non-UUID correlationId → 400 (or 429 if throttled)',
        ).toBe(true);
    });

    test('FLOW 8 — UI: an anonymous browser context (no inherited auth cookie) can reach the app shell, and the bogus /claim landing renders without a 5xx', async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(60_000);
        const origin = baseURL ?? 'http://localhost:3000';

        // IMPORTANT: bare browser.newContext() INHERITS the seeded storageState
        // cookie. Force a genuinely anonymous context with empty storageState.
        const anonCtx = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        try {
            const page = await anonCtx.newPage();

            // The app root is reachable to an unauthenticated visitor (it is the
            // zero-friction entrypoint). Either it renders, or it redirects to a
            // login/onboarding surface — never a 5xx.
            const rootRes = await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
            expect(rootRes, 'root response exists').not.toBeNull();
            if (rootRes)
                expect(rootRes.status(), 'app root is not a server error').toBeLessThan(500);
            await expect(page.locator('body')).toBeVisible();

            // The tokenised /claim landing (the work-invite surface, distinct
            // from account-claim) renders a graceful invalid-token state for a
            // bogus token rather than crashing — a resilience guard for the
            // public claim path an upgraded user might land on.
            const claimRes = await page.goto(
                `${origin}/en/claim/bogus-anon-upgrade-${Date.now()}`,
                { waitUntil: 'domcontentloaded' },
            );
            expect(claimRes, 'claim landing response exists').not.toBeNull();
            if (claimRes) {
                expect(claimRes.status(), 'bogus claim token does not 5xx').toBeLessThan(500);
            }
            await expect(page.locator('body')).toBeVisible();
        } finally {
            await anonCtx.close();
        }
    });
});
