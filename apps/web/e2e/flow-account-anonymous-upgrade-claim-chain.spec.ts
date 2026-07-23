import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Anonymous → claim → account UPGRADE: cross-surface DATA-CONTINUITY chain
 * (EW-617 G2/G3/G4).
 *
 * The zero-friction funnel mints a throwaway anonymous `User` row so a visitor
 * can accumulate REAL account state — onboarding-wizard choices, an activity
 * trail, owned Works, an exportable account snapshot — BEFORE committing an
 * email+password. `POST /api/auth/claim` upgrades that SAME row in place (the
 * `id` never changes), so every account-scoped surface that keys off `userId`
 * must carry over untouched. The sibling specs
 * (`flow-account-anonymous-upgrade`, `flow-claim-zero-friction*`) already pin
 * the Work-OWNERSHIP carryover, the claim negative matrix, and the anon
 * DTO/TTL contract. THIS suite deliberately covers the OTHER account-side
 * surfaces those leave untouched — proving the upgrade is transparent across:
 *
 *   - the onboarding-wizard server state  (`/api/onboarding/*`),
 *   - the activity/audit trail            (`/api/activity-log`),
 *   - the account export snapshot         (`/api/account/export`),
 *   - the profile + credential surface    (`/api/auth/profile`, update-password),
 *
 * and the "anon-born vs register-born" distinction those surfaces encode.
 *
 * Every shape/status/message below was confirmed against the LIVE stack
 * (sqlite in-memory — the same driver CI uses) BEFORE assertions were written:
 *
 *   POST /api/auth/anonymous → 201 { access_token, user:{ id, email:null,
 *        username:/^anon-[0-9a-f]{8}$/, isAnonymous:true, anonymousExpiresAt } }.
 *        @Throttle 5/hr per IP → tolerate 429 (mint returns null → test.skip).
 *   GET  /api/onboarding/state (anon OR registered) → 200 { completedAt:null,
 *        dismissedAt:null, state:{ version:2, lastStep:0, ai:{choice:'ever-works'},
 *        storage:{choice:'ever-works-git'}, deploy:{choice:'ever-works'},
 *        skippedSteps:[], pluginsReviewed:false } }.
 *   PATCH /api/onboarding/state → 200; server DEEP-MERGES the partial into the
 *        persisted v2 shape (patching lastStep leaves ai/storage/deploy intact).
 *        Validation gate: ai.choice ∉ enum → 400 array
 *        'state.ai.choice must be one of the following values: …';
 *        unknown inner key → 400 'state.property <x> should not exist';
 *        unknown top key → 400 'property <x> should not exist';
 *        prompt > 5000 chars → 400. Auth required (no/garbage bearer → 401).
 *   POST /api/onboarding/complete|dismiss → 200 { completedAt|dismissedAt set },
 *        idempotent (a second call keeps the same timestamp).
 *   GET  /api/activity-log?limit=N → 200 { activities:[{ id, userId, workId,
 *        actionType:'user_login'|…, action:'user.anonymous_created'|
 *        'user.account_claimed'|'user.signup'|'work.created'|…, status:'completed',
 *        … }], total }. A fresh anon carries exactly one 'user.anonymous_created'
 *        row; after claim the SAME userId also carries 'user.account_claimed'.
 *        A register-born account NEVER has 'user.anonymous_created'.
 *   GET  /api/activity-log/summary → 200 { counts:{ pending, in_progress,
 *        completed, failed, cancelled } }.
 *   POST /api/works (anon bearer) → 200 { status:'success', work:{ id, userId,
 *        owner:'anon-…', slug } }.
 *   GET  /api/account/export → 200 { version:1, exportedAt, includesSecrets:bool,
 *        data:{ profile:{ username, email }, works:[{ name, slug, … }],
 *        userPlugins:[] } }. An ANON's export has profile.email === null; after
 *        claim it flips to the claimed email while owned Works persist.
 *        ?includeSecrets=true → includesSecrets:true. Auth required (401).
 *   GET  /api/account/sync/status → 200 { configured:false, hasOAuth:false }.
 *   POST /api/auth/claim (anon bearer) → 200 { id (UNCHANGED), email, username
 *        (anon username unless overridden), emailVerified:false }. Flips
 *        isAnonymous→false, registrationProvider→'local', clears TTL. A
 *        register-born (non-anon) caller → 403. No/garbage bearer → 401.
 *   PUT  /api/auth/profile → 200 full fresh user { id, username (updated), slug
 *        (STABLE — minted at anon birth, unaffected by username changes),
 *        email, registrationProvider:'local', isAnonymous:false,
 *        anonymousExpiresAt:null, onboardingState, onboardingCompletedAt, … }.
 *   POST /api/auth/update-password → an ANON (no credentials yet) → 401
 *        'Password login is not configured for this account'; a CLAIMED account
 *        with the right currentPassword → 200 { message:'Password updated …' }.
 *   POST /api/auth/login → 200 { access_token, user:{ id } }; wrong/old password
 *        → 401.
 *
 * Isolation: every flow mints FRESH anon/registered users + fresh Works — never
 * the shared seeded storageState user — so the in-memory DB stays clean for
 * sibling specs. Assertions tolerate pre-existing rows (toContain / per-id
 * checks, never exact global counts). All API-driven except the final UI
 * resilience test (empty storageState → genuinely anonymous context).
 */

const ANON_USERNAME_RE = /^anon-[0-9a-f]{8}$/;

interface AnonSession {
    token: string;
    userId: string;
    username: string;
    anonymousExpiresAt: string;
}

/**
 * Mint a throwaway zero-friction session. Returns `null` when the per-IP
 * throttle (5/hr) trips so the caller can `test.skip` rather than flake. Any
 * other non-201 is a real failure and is asserted on.
 */
async function mintAnon(request: APIRequestContext): Promise<AnonSession | null> {
    const res = await request.post(`${API_BASE}/api/auth/anonymous`, { data: {} });
    if (res.status() === 429) return null;
    expect(res.status(), 'anonymous mint → 201').toBe(201);
    const body = await res.json();
    expect(typeof body?.access_token, 'opaque session token issued').toBe('string');
    expect(body?.user?.isAnonymous, 'minted row flagged anonymous').toBe(true);
    expect(String(body?.user?.username)).toMatch(ANON_USERNAME_RE);
    expect(body?.user?.email, 'anon has no email at birth').toBeFalsy();
    return {
        token: body.access_token,
        userId: body.user.id,
        username: body.user.username,
        anonymousExpiresAt: body.user.anonymousExpiresAt,
    };
}

function uniqueSuffix(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function uniqueEmail(tag: string): string {
    return `anon-chain-${tag}-${uniqueSuffix()}@test.local`;
}

async function createWorkAsAnon(
    request: APIRequestContext,
    token: string,
    name: string,
): Promise<{ id: string; slug: string }> {
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${uniqueSuffix()}`;
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

async function getState(request: APIRequestContext, token: string) {
    const res = await request.get(`${API_BASE}/api/onboarding/state`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'onboarding state readable').toBe(200);
    return res.json();
}

async function exportAccount(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{
    version: number;
    includesSecrets: boolean;
    data: {
        profile: { username: string; email: string | null };
        works: Array<{ slug: string; name: string }>;
        userPlugins: unknown[];
    };
}> {
    const res = await request.get(`${API_BASE}/api/account/export${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'account export readable').toBe(200);
    return res.json();
}

async function listActions(
    request: APIRequestContext,
    token: string,
): Promise<{
    actions: string[];
    userIds: string[];
    total: number;
}> {
    const res = await request.get(`${API_BASE}/api/activity-log?limit=50`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'activity log readable').toBe(200);
    const body = await res.json();
    const activities: Array<{ action: string; userId: string }> = body.activities ?? [];
    return {
        actions: activities.map((a) => a.action),
        userIds: activities.map((a) => a.userId),
        total: body.total,
    };
}

test.describe('Anonymous → claim → account-upgrade continuity chain (EW-617 G2/G3/G4)', () => {
    test.describe.configure({ mode: 'serial' });

    // ─────────────────────────────────────────────────────────────────────
    // ANON-CONSUMING FLOWS (each mints one anon; tolerate the 5/hr throttle)
    // ─────────────────────────────────────────────────────────────────────

    test('CONTINUITY 1 — onboarding-wizard state built while anonymous survives the claim byte-for-byte', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled (5/hr per IP) — skipping');
        if (!anon) return;

        // Fresh anon starts at the documented v2 defaults.
        const initial = await getState(request, anon.token);
        expect(initial.completedAt).toBeNull();
        expect(initial.dismissedAt).toBeNull();
        expect(initial.state.version).toBe(2);
        expect(initial.state.lastStep).toBe(0);
        expect(initial.state.ai.choice).toBe('ever-works');
        expect(initial.state.pluginsReviewed).toBe(false);

        // The anon walks the wizard: picks a non-default AI provider, advances,
        // types a landing-page prompt (G4), marks plugins reviewed.
        const patchRes = await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: authedHeaders(anon.token),
            data: {
                state: {
                    lastStep: 3,
                    ai: { choice: 'openrouter' },
                    prompt: 'a curated directory of open-source AI tools',
                    pluginsReviewed: true,
                },
            },
        });
        expect(patchRes.status(), 'anon can persist wizard state').toBe(200);
        const patched = await patchRes.json();
        expect(patched.state.lastStep).toBe(3);
        expect(patched.state.ai.choice).toBe('openrouter');
        expect(patched.state.prompt).toBe('a curated directory of open-source AI tools');
        // Deep-merge preserved the untouched defaults.
        expect(patched.state.storage.choice).toBe('ever-works-git');
        expect(patched.state.deploy.choice).toBe('ever-works');

        // CLAIM the account (same bearer, same row).
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('onboard'), password: 'OnboardKeep1!' },
        });
        expect(claim.status(), 'claim → 200').toBe(200);
        expect((await claim.json()).id, 'claim keeps the same row id').toBe(anon.userId);

        // The wizard state is IDENTICAL after the upgrade — no reset, no loss.
        const after = await getState(request, anon.token);
        expect(after.state.lastStep, 'lastStep survives claim').toBe(3);
        expect(after.state.ai.choice, 'AI choice survives claim').toBe('openrouter');
        expect(after.state.prompt, 'landing-page prompt survives claim').toBe(
            'a curated directory of open-source AI tools',
        );
        expect(after.state.pluginsReviewed, 'pluginsReviewed survives claim').toBe(true);
        expect(after.state.storage.choice).toBe('ever-works-git');
    });

    test('CONTINUITY 2 — the activity trail is continuous: anonymous_created + account_claimed + work.created all live under the SAME userId', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        // A fresh anon already has exactly one audit row: the mint event.
        const born = await listActions(request, anon.token);
        expect(born.actions, 'anon birth is audited').toContain('user.anonymous_created');
        expect(
            born.userIds.every((id) => id === anon.userId),
            'the mint audit row is owned by the anon',
        ).toBe(true);

        // Build a Work → adds a work.created audit row.
        await createWorkAsAnon(request, anon.token, 'Audited Anon Work');

        // Claim → adds a user.account_claimed audit row.
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('audit'), password: 'AuditKeep1!' },
        });
        expect(claim.status()).toBe(200);

        // The upgraded account's trail carries the WHOLE history — the pre-claim
        // anon rows are NOT orphaned or renamed, and every row is still the same
        // userId (the id never changed).
        const after = await listActions(request, anon.token);
        expect(after.actions, 'birth event still present post-claim').toContain(
            'user.anonymous_created',
        );
        expect(after.actions, 'claim event recorded').toContain('user.account_claimed');
        expect(after.actions, 'the anon-created Work event carried over').toContain('work.created');
        expect(after.total, 'the trail only grew across the upgrade').toBeGreaterThanOrEqual(
            born.total,
        );
        expect(
            after.userIds.every((id) => id === anon.userId),
            'every audit row stays bound to the single upgraded row',
        ).toBe(true);

        // The status summary agrees these are completed events.
        const summary = await request
            .get(`${API_BASE}/api/activity-log/summary`, { headers: authedHeaders(anon.token) })
            .then((r) => r.json());
        expect(summary.counts, 'summary exposes the status buckets').toHaveProperty('completed');
        expect(
            summary.counts.completed,
            'claimed account has completed audit events',
        ).toBeGreaterThan(0);
    });

    test('CONTINUITY 3 — the account export snapshot flips email null→set on claim while owned Works persist unchanged', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        const work = await createWorkAsAnon(request, anon.token, 'Exportable Anon Work');

        // BEFORE: an anon export is a real, downloadable snapshot with a
        // null-email identity but its owned Work already inside.
        const before = await exportAccount(request, anon.token);
        expect(before.version, 'export contract version').toBe(1);
        expect(before.includesSecrets, 'secrets off by default').toBe(false);
        expect(before.data.profile.email, 'anon export has a null email').toBeNull();
        expect(String(before.data.profile.username)).toMatch(ANON_USERNAME_RE);
        expect(
            before.data.works.map((w) => w.slug),
            'anon-owned work is in the pre-claim export',
        ).toContain(work.slug);

        // CLAIM.
        const email = uniqueEmail('export');
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email, password: 'ExportKeep1!' },
        });
        expect(claim.status()).toBe(200);

        // AFTER: the SAME snapshot now carries the claimed email; the Work is
        // still present (ownership binds by the unchanged userId); the anon
        // username is retained (no override was passed).
        const after = await exportAccount(request, anon.token);
        expect(
            String(after.data.profile.email).toLowerCase(),
            'export email flips to claimed',
        ).toBe(email.toLowerCase());
        expect(String(after.data.profile.username), 'username retained without override').toMatch(
            ANON_USERNAME_RE,
        );
        expect(
            after.data.works.map((w) => w.slug),
            'the pre-claim Work survives in the post-claim export',
        ).toContain(work.slug);

        // The secrets toggle still flips the header flag on the upgraded account.
        const secretsOn = await exportAccount(request, anon.token, '?includeSecrets=true');
        expect(secretsOn.includesSecrets, 'includeSecrets=true flips the flag').toBe(true);
        expect(secretsOn.data.works.map((w) => w.slug)).toContain(work.slug);
    });

    test('CONTINUITY 4 — PUT /profile on the upgraded account renames the user but the slug minted at anon birth is stable, and identity reads as permanent', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        // Claim WITHOUT a username override → username stays the anon handle.
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('profile'), password: 'ProfileKeep1!' },
        });
        expect(claim.status()).toBe(200);
        expect((await claim.json()).username, 'no override → anon username kept').toBe(
            anon.username,
        );

        // Now rename via the profile surface.
        const newName = `renamed-${uniqueSuffix()}`.slice(0, 20);
        const putRes = await request.put(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(anon.token),
            data: { username: newName },
        });
        expect(putRes.status(), 'profile update → 200').toBe(200);
        const fresh = await putRes.json();
        expect(fresh.id, 'same row throughout').toBe(anon.userId);
        expect(fresh.username, 'username updated').toBe(newName);
        // The slug was minted from the anon username at birth and does NOT track
        // later username changes — it is stable across the whole chain.
        expect(String(fresh.slug), 'slug minted at anon birth is stable').toBe(anon.username);
        expect(String(fresh.slug)).toMatch(ANON_USERNAME_RE);
        // Identity now reads permanent everywhere.
        expect(fresh.isAnonymous, 'no longer anonymous').toBe(false);
        expect(fresh.registrationProvider, 'provider flipped to local').toBe('local');
        expect(fresh.anonymousExpiresAt, 'TTL cleared').toBeNull();
        // The fresh profile echoes the onboarding sub-state (never wiped).
        expect(fresh).toHaveProperty('onboardingState');
    });

    test('CONTINUITY 5 — credentials only exist AFTER claim: anon update-password is 401, claim then rotates, and old passwords stop working', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        // An anon has no password-login credential yet, so update-password is
        // rejected with the exact "not configured" message (not a 500).
        const preClaim = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(anon.token),
            data: { currentPassword: 'whatever1!', newPassword: 'Nope123456!' },
        });
        expect(preClaim.status(), 'anon update-password → 401').toBe(401);
        expect(String((await preClaim.json()).message)).toMatch(/not configured/i);

        // Claim attaches the first credential.
        const email = uniqueEmail('pwd');
        const firstPassword = 'FirstClaim1!';
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email, password: firstPassword },
        });
        expect(claim.status()).toBe(200);

        // Rotate the just-attached credential (proves it really was set).
        const secondPassword = 'SecondClaim2!';
        const rotate = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(anon.token),
            data: { currentPassword: firstPassword, newPassword: secondPassword },
        });
        expect(rotate.status(), 'claimed account can rotate its password').toBe(200);
        expect(String((await rotate.json()).message)).toMatch(/updated/i);

        // The NEW password logs in and resolves to the SAME upgraded row.
        const loginNew = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password: secondPassword },
        });
        expect(loginNew.status(), 'new password logs in').toBe(200);
        expect((await loginNew.json()).user.id, 'login resolves the same id').toBe(anon.userId);

        // The old (claim-time) password no longer works.
        const loginOld = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password: firstPassword },
        });
        expect(loginOld.status(), 'rotated-out password → 401').toBe(401);
    });

    test('CONTINUITY 6 — onboarding completion done while anonymous carries its timestamp through the claim (idempotent both sides)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        // Complete the wizard while still anonymous.
        const complete = await request.post(`${API_BASE}/api/onboarding/complete`, {
            headers: authedHeaders(anon.token),
        });
        expect(complete.status(), 'anon can complete onboarding').toBe(200);
        const completedAt = (await complete.json()).completedAt;
        expect(completedAt, 'completedAt stamped').toBeTruthy();

        // Idempotent while anon: a second complete keeps the same instant.
        const completeAgain = await request
            .post(`${API_BASE}/api/onboarding/complete`, { headers: authedHeaders(anon.token) })
            .then((r) => r.json());
        expect(completeAgain.completedAt, 'complete is idempotent').toBe(completedAt);

        // CLAIM.
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('complete'), password: 'CompleteKeep1!' },
        });
        expect(claim.status()).toBe(200);

        // The completion timestamp survives the upgrade untouched.
        const afterState = await getState(request, anon.token);
        expect(afterState.completedAt, 'completedAt survives the claim').toBe(completedAt);
        expect(afterState.dismissedAt, 'still not dismissed').toBeNull();
    });

    test('CONTINUITY 7 — onboarding state stays MUTABLE after the upgrade: a post-claim PATCH persists on the same row', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        // Set an initial state while anon.
        await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: authedHeaders(anon.token),
            data: { state: { lastStep: 1, deploy: { choice: 'vercel' } } },
        });

        // CLAIM.
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('mutable'), password: 'MutableKeep1!' },
        });
        expect(claim.status()).toBe(200);

        // A PATCH AFTER the claim still lands and deep-merges over the carried state.
        const postPatch = await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: authedHeaders(anon.token),
            data: { state: { lastStep: 6, storage: { choice: 'user-github' } } },
        });
        expect(postPatch.status(), 'onboarding remains writable post-claim').toBe(200);
        const merged = (await postPatch.json()).state;
        expect(merged.lastStep, 'post-claim update applied').toBe(6);
        expect(merged.storage.choice, 'new storage choice applied').toBe('user-github');
        expect(merged.deploy.choice, 'pre-claim deploy choice retained via deep-merge').toBe(
            'vercel',
        );
    });

    test('CONTINUITY 8 — HEADLINE: an anon builds state + owns a Work, claims, then logs in FRESH and every surface is coherent under the new session token', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        // Build meaningful anonymous state.
        await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: authedHeaders(anon.token),
            data: { state: { lastStep: 4, ai: { choice: 'gemini' }, prompt: 'headline chain' } },
        });
        const work = await createWorkAsAnon(request, anon.token, 'Headline Chain Work');

        // CLAIM, then discard the anon bearer entirely and LOG IN afresh — the
        // real acid test that the upgraded credentials own all the state.
        const email = uniqueEmail('headline');
        const password = 'HeadlineChain1!';
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email, password },
        });
        expect(claim.status()).toBe(200);

        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password },
        });
        expect(login.status(), 'claimed creds log in').toBe(200);
        const loginToken = (await login.json()).access_token;
        expect(loginToken, 'fresh session token issued').toBeTruthy();
        expect(loginToken, 'fresh token differs from the anon bearer').not.toBe(anon.token);

        // Under the FRESH login session, identity is permanent…
        const profile = await request
            .get(`${API_BASE}/api/auth/profile`, { headers: authedHeaders(loginToken) })
            .then((r) => r.json());
        expect(profile.id, 'login resolves the same upgraded row').toBe(anon.userId);
        expect(profile.isAnonymous).toBe(false);
        expect(profile.provider).toBe('local');

        // …onboarding wizard state carried over…
        const state = await getState(request, loginToken);
        expect(state.state.lastStep).toBe(4);
        expect(state.state.ai.choice).toBe('gemini');
        expect(state.state.prompt).toBe('headline chain');

        // …the Work is owned + exportable under the new session…
        const exported = await exportAccount(request, loginToken);
        expect(String(exported.data.profile.email).toLowerCase()).toBe(email.toLowerCase());
        expect(exported.data.works.map((w) => w.slug)).toContain(work.slug);

        const works = await request
            .get(`${API_BASE}/api/works?limit=100`, { headers: authedHeaders(loginToken) })
            .then((r) => r.json());
        expect((works.works ?? []).map((w: { slug: string }) => w.slug)).toContain(work.slug);

        // …and the audit trail is complete under the new session.
        const trail = await listActions(request, loginToken);
        expect(trail.actions).toContain('user.anonymous_created');
        expect(trail.actions).toContain('user.account_claimed');
    });

    test('CONTINUITY 9 — the upgraded account’s Work + export are STILL isolated from third parties after the claim', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        const work = await createWorkAsAnon(request, anon.token, 'Isolated Upgrade Work');

        // Claim the anon → permanent.
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email: uniqueEmail('iso'), password: 'IsoUpgrade1!' },
        });
        expect(claim.status()).toBe(200);

        // A totally separate registered stranger must never see the Work in
        // their own list, their own export, or a direct GET.
        const stranger = await registerUserViaAPI(request);
        const strangerGet = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(
            [403, 404].includes(strangerGet.status()),
            'stranger cannot read the upgraded account’s Work',
        ).toBe(true);

        const strangerExport = await exportAccount(request, stranger.access_token);
        expect(
            strangerExport.data.works.map((w) => w.slug),
            'the Work never leaks into a stranger’s export',
        ).not.toContain(work.slug);
    });

    test('CONTINUITY 10 — a claim WITH a username override propagates the new handle to both profile and export, on the same id', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const anon = await mintAnon(request);
        test.skip(!anon, 'anonymous mint throttled — skipping');
        if (!anon) return;

        const overrideName = `claimed${uniqueSuffix()}`.slice(0, 18);
        const email = uniqueEmail('override');
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.token),
            data: { email, password: 'OverrideKeep1!', username: overrideName },
        });
        expect(claim.status(), 'claim with override → 200').toBe(200);
        const claimed = await claim.json();
        expect(claimed.id, 'still the same row').toBe(anon.userId);
        expect(claimed.username, 'override applied on claim').toBe(overrideName);

        // The override is reflected in the fresh profile and the export snapshot.
        const fresh = await request
            .get(`${API_BASE}/api/auth/profile/fresh`, { headers: authedHeaders(anon.token) })
            .then((r) => r.json());
        expect(fresh.username, 'override persisted to the row').toBe(overrideName);
        expect(fresh.isAnonymous).toBe(false);

        const exported = await exportAccount(request, anon.token);
        expect(exported.data.profile.username, 'export carries the overridden handle').toBe(
            overrideName,
        );
        expect(String(exported.data.profile.email).toLowerCase()).toBe(email.toLowerCase());
    });

    // ─────────────────────────────────────────────────────────────────────
    // NON-ANON FLOWS (no mint — resilient to the anon throttle)
    // ─────────────────────────────────────────────────────────────────────

    test('DISTINCTION — a register-born account cannot claim (403) and its audit trail never carries anonymous_created', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);

        // The claim door is anonymous-only.
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(user.access_token),
            data: { email: uniqueEmail('regclaim'), password: 'RegClaim123!' },
        });
        expect(claim.status(), 'register-born claim → 403').toBe(403);
        expect(String((await claim.json()).message)).toMatch(/anonymous/i);

        // The register-born trail is a signup, never an anon-birth.
        const trail = await listActions(request, user.access_token);
        expect(
            trail.actions,
            'register-born accounts are never flagged anonymous_created',
        ).not.toContain('user.anonymous_created');
        expect(trail.actions, 'register-born accounts have no account_claimed event').not.toContain(
            'user.account_claimed',
        );
    });

    test('DISTINCTION — a register-born export carries a real email from the start (contrast to an anon’s null-email snapshot)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const exported = await exportAccount(request, user.access_token);
        expect(exported.version).toBe(1);
        expect(
            String(exported.data.profile.email).toLowerCase(),
            'register-born export has the account email',
        ).toBe(user.email.toLowerCase());
        expect(Array.isArray(exported.data.works)).toBe(true);
        expect(Array.isArray(exported.data.userPlugins)).toBe(true);
    });

    test('AUTHZ — every account-continuity surface refuses an unauthenticated or garbage-token caller', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const garbage = { Authorization: 'Bearer not.a.real.token.xyz' };

        for (const path of [
            '/api/account/export',
            '/api/onboarding/state',
            '/api/activity-log',
            '/api/account/sync/status',
        ]) {
            const noAuth = await request.get(`${API_BASE}${path}`);
            expect(noAuth.status(), `${path} with no bearer → 401`).toBe(401);
            const bad = await request.get(`${API_BASE}${path}`, { headers: garbage });
            expect(bad.status(), `${path} with garbage bearer → 401`).toBe(401);
        }

        // Claim also requires a (valid, anonymous) session — no bearer → 401.
        const noAuthClaim = await request.post(`${API_BASE}/api/auth/claim`, {
            data: { email: uniqueEmail('noauth'), password: 'NoAuth12345!' },
        });
        expect(noAuthClaim.status(), 'claim with no bearer → 401').toBe(401);
        const garbageClaim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: garbage,
            data: { email: uniqueEmail('garbage'), password: 'Garbage12345!' },
        });
        expect(garbageClaim.status(), 'claim with garbage bearer → 401').toBe(401);
    });

    test('ONBOARDING GATE — the wizard-state PATCH validates hard: bad enum, unknown keys, and oversized prompt are all 400', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        // Out-of-enum AI choice → 400 with the enum-listing array message.
        const badEnum = await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: h,
            data: { state: { ai: { choice: 'not-a-real-provider' } } },
        });
        expect(badEnum.status(), 'bad ai.choice → 400').toBe(400);
        expect(JSON.stringify((await badEnum.json()).message)).toMatch(
            /must be one of the following values/i,
        );

        // Unknown INNER key → 400 (nested forbidNonWhitelisted).
        const badInner = await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: h,
            data: { state: { bogusInner: 'x' } },
        });
        expect(badInner.status(), 'unknown inner key → 400').toBe(400);
        expect(JSON.stringify((await badInner.json()).message)).toMatch(/should not exist/i);

        // Unknown TOP-level key → 400.
        const badTop = await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: h,
            data: { foo: 'x' },
        });
        expect(badTop.status(), 'unknown top-level key → 400').toBe(400);

        // Oversized prompt (> 5000 chars) → 400 (DoS guard on the JSON column).
        const oversized = await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: h,
            data: { state: { prompt: 'a'.repeat(5001) } },
        });
        expect(oversized.status(), 'prompt > 5000 chars → 400').toBe(400);
    });

    test('ONBOARDING MERGE — partial PATCHes deep-merge into the persisted v2 shape without clobbering untouched fields', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        // Patch only lastStep → the AI default is untouched.
        const step = await request
            .patch(`${API_BASE}/api/onboarding/state`, {
                headers: h,
                data: { state: { lastStep: 5 } },
            })
            .then((r) => r.json());
        expect(step.state.lastStep).toBe(5);
        expect(step.state.ai.choice, 'unrelated field untouched by partial patch').toBe(
            'ever-works',
        );

        // Now patch only the AI choice → lastStep from the previous patch survives.
        const ai = await request
            .patch(`${API_BASE}/api/onboarding/state`, {
                headers: h,
                data: { state: { ai: { choice: 'codex' } } },
            })
            .then((r) => r.json());
        expect(ai.state.ai.choice).toBe('codex');
        expect(ai.state.lastStep, 'earlier lastStep survives the second patch').toBe(5);
        expect(ai.state.version).toBe(2);
    });

    test('ONBOARDING LIFECYCLE — complete and dismiss are independent, idempotent stamps on a register-born account', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const first = await request
            .post(`${API_BASE}/api/onboarding/complete`, { headers: h })
            .then((r) => r.json());
        expect(first.completedAt, 'completedAt stamped').toBeTruthy();

        const second = await request
            .post(`${API_BASE}/api/onboarding/complete`, { headers: h })
            .then((r) => r.json());
        expect(second.completedAt, 'complete is idempotent').toBe(first.completedAt);

        const dismissed = await request
            .post(`${API_BASE}/api/onboarding/dismiss`, { headers: h })
            .then((r) => r.json());
        expect(dismissed.dismissedAt, 'dismissedAt stamped').toBeTruthy();
        // Dismiss does not clear the completion stamp — they coexist.
        expect(dismissed.completedAt, 'completion stamp coexists with dismissal').toBe(
            first.completedAt,
        );
    });

    test('SYNC — the GitHub-sync status surface reports an unconfigured, no-OAuth account for a fresh (register-born) user', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const status = await request
            .get(`${API_BASE}/api/account/sync/status`, {
                headers: authedHeaders(user.access_token),
            })
            .then((r) => r.json());
        expect(status.configured, 'no sync repo configured yet').toBe(false);
        expect(status.hasOAuth, 'no GitHub OAuth linked yet').toBe(false);
    });

    test('EXPORT CONTRACT — the account export honours the secrets toggle and returns the stable v1 payload shape', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);

        const plain = await exportAccount(request, user.access_token);
        expect(plain.version, 'v1 payload').toBe(1);
        expect(plain.includesSecrets, 'secrets off without the query flag').toBe(false);
        expect(plain.data, 'export has the three canonical sections').toHaveProperty('profile');
        expect(plain.data).toHaveProperty('works');
        expect(plain.data).toHaveProperty('userPlugins');

        const withSecrets = await exportAccount(request, user.access_token, '?includeSecrets=true');
        expect(withSecrets.includesSecrets, 'includeSecrets=true flips the header flag').toBe(true);
    });

    test('AUDIT FILTER — the activity-log filter contract narrows by actionType/status (the same surface that proves upgrade continuity)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        // A register-born account's sole audit row is its signup.
        const full = await request
            .get(`${API_BASE}/api/activity-log?limit=25`, { headers: h })
            .then((r) => r.json());
        expect(full.total, 'fresh account has at least the signup row').toBeGreaterThanOrEqual(1);
        expect(
            (full.activities ?? []).map((a: { action: string }) => a.action),
            'signup is audited',
        ).toContain('user.signup');

        // Filtering by the signup actionType returns ONLY user_signup rows.
        const signupOnly = await request
            .get(`${API_BASE}/api/activity-log?actionType=user_signup`, { headers: h })
            .then((r) => r.json());
        expect(signupOnly.total, 'signup filter matches at least one row').toBeGreaterThanOrEqual(
            1,
        );
        expect(
            (signupOnly.activities ?? []).every(
                (a: { actionType: string }) => a.actionType === 'user_signup',
            ),
            'actionType filter is exact',
        ).toBe(true);

        // Filtering by a status the account has never produced returns nothing —
        // and any returned row would have to match the filter (vacuously true).
        const failed = await request
            .get(`${API_BASE}/api/activity-log?status=failed`, { headers: h })
            .then((r) => r.json());
        expect(
            (failed.activities ?? []).every((a: { status: string }) => a.status === 'failed'),
            'status filter is exact',
        ).toBe(true);

        // Filtering by an actionType the account has no rows for → empty page.
        const noneOfThat = await request
            .get(`${API_BASE}/api/activity-log?actionType=work_generation`, { headers: h })
            .then((r) => r.json());
        expect(noneOfThat.total, 'a non-matching actionType yields an empty page').toBe(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // UI RESILIENCE (genuinely anonymous browser context — empty storageState)
    // ─────────────────────────────────────────────────────────────────────

    test('UI — a genuinely anonymous browser context reaches the app shell without a 5xx (zero-friction entrypoint)', async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(60_000);
        const origin = baseURL ?? 'http://localhost:3000';

        // Bare newContext() would INHERIT the seeded storageState cookie — force
        // an empty state so this is a real anonymous visitor.
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const page = await anonCtx.newPage();

            const rootRes = await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
            expect(rootRes, 'root response exists').not.toBeNull();
            if (rootRes) {
                expect(rootRes.status(), 'app root is not a server error').toBeLessThan(500);
            }
            await expect(page.locator('body')).toBeVisible();

            // A settings/account destination an upgraded user would land on must
            // not 5xx for an anonymous visitor (it may render or redirect to
            // login/onboarding — never crash).
            const acctRes = await page.goto(`${origin}/en/settings`, {
                waitUntil: 'domcontentloaded',
            });
            if (acctRes) {
                expect(acctRes.status(), 'settings destination does not 5xx').toBeLessThan(500);
            }
            await expect(page.locator('body')).toBeVisible();
        } finally {
            await anonCtx.close();
        }
    });
});
