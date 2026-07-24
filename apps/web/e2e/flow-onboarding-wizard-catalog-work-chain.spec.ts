import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * ONBOARDING → CATALOG → (register-work agent plane) → FIRST WORK, end-to-end.
 *
 * This file walks the onboarding wizard as a STATE MACHINE and stitches it to
 * its real culmination — the user's first Work — then proves the two onboarding
 * "planes" are decoupled: the AUTHENTICATED wizard plane
 * (`/api/onboarding/{catalog,state,complete,dismiss,telemetry}`, Bearer-gated,
 * self-scoped to `auth.userId`) versus the PUBLIC agent plane
 * (`/api/register-work`, X-GitHub-Token-gated). Every status code, body shape,
 * and error string asserted below was probed against the LIVE API at
 * http://127.0.0.1:3100 (sqlite in-memory, keyless — no LLM provider,
 * Trigger.dev unbound, Ever-Works Git/Deploy env-flags OFF) BEFORE the
 * assertions were written.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────
 * Deliberately DISJOINT from the sibling onboarding / register-work specs —
 * this file owns the CROSS-ENDPOINT CHAIN + the two-plane decoupling, not any
 * single endpoint's depth:
 *   - flow-onboarding-wizard-deep.spec.ts     — deep-merge sibling preservation,
 *     lastStep clamp, complete↔dismiss badge machine. THIS file threads a REAL
 *     Work through the lifecycle and pins the catalog↔state DEFAULT coherence.
 *   - flow-onboarding-catalog-choices.spec.ts — availability gating, per-choice
 *     config-step reshaping, device-auth. THIS file adds the reserved-pluginId
 *     EXCLUSION invariant + catalog user-invariance (server-authoritative).
 *   - flow-onboarding-telemetry.spec.ts       — the full 18-event allow-list +
 *     the anonymous zero-friction funnel. THIS file touches telemetry only to
 *     prove it MIRRORS but never DRIVES the state machine.
 *   - flow-register-work-{deep,flow}.spec.ts  — the register-work DTO gradient +
 *     credential/status state machine. THIS file touches register-work only as
 *     the DECOUPLED agent plane (Bearer-irrelevant, cross-plane state isolation).
 *
 * ── PROBED CONTRACTS (verified live) ─────────────────────────────────────
 *  GET  /api/onboarding/catalog → 200 authed / 401 anon; { ai[6], storage[4],
 *    deploy[3], plugins[] }; server-authoritative (byte-identical across users).
 *    Each bucket has exactly ONE default; a card carries the 'planned' badge IFF
 *    available:false; the AI default 'ever-works' is available:true; BYOK/own
 *    cards carry a pluginId + 'byok'/[] badges. plugins[] is DISJOINT from every
 *    card pluginId (reservedPluginIds) and sorted by onboardingPriority asc.
 *  GET  /api/onboarding/state (fresh) → { completedAt:null, dismissedAt:null,
 *    state: ONBOARDING_DEFAULT_STATE (version 2, ever-works triple, lastStep 0,
 *    []/false, no prompt) }; anon → 401.
 *  PATCH /api/onboarding/state → 200 deep-merge (version pinned 2); invalid ai
 *    choice → 400 enum msg; lastStep<0 → 400; skippedSteps >20 → 400, element
 *    >64 → 400; prompt >5000 → 400; unknown key top-level / state-level / nested
 *    (state.ai.property x) → 400 forbidNonWhitelisted; {ai:{}} (no choice) → 400;
 *    prompt is RETAINED across patches that omit it; skippedSteps REPLACES (not
 *    appends); a valid-but-"planned"/unavailable choice is ACCEPTED (state
 *    machine is decoupled from catalog availability).
 *  POST /api/onboarding/complete → 200 { completedAt:ISO, … } idempotent (same
 *    ts on repeat); POST /api/onboarding/dismiss → 200 { dismissedAt:ISO } —
 *    independent + both idempotent; both anon → 401.
 *  POST /api/onboarding/telemetry → 204 (empty body); unknown event → 400 enum;
 *    anon → 401; NEVER mutates state.
 *  POST /api/works → 200 { status:'success', work:{ id, acceptedFromIdeaId:null,
 *    kind:'default', status:'active', … } }; GET /api/works → { status:'success',
 *    works[], total, limit, offset }; GET /api/works/:id → 200; dup slug → 400;
 *    Work creation is INDEPENDENT of onboarding lifecycle.
 *  POST /api/register-work (Public) → missing X-GitHub-Token → 400
 *    validation_error (Bearer irrelevant); token<4 → 401 gh_credential_invalid;
 *    unresolvable token → 403 gh_credential_invalid (mints nothing); bad repo →
 *    400 class-validator array; feature ON (never 404 feature_disabled).
 *  GET  /api/register-work/:id (Public) → missing token → 403; non-uuid → 400
 *    ParseUUIDPipe; unknown uuid + token → 404 not_found.
 *
 * Cross-spec isolation: EVERY test builds on FRESH registerUserViaAPI() users
 * (unique suffixes). List assertions use toContain / exact-own-id — never global
 * counts. No module-scope data loading.
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

const AI_CHOICES = ['ever-works', 'openrouter', 'claude-code', 'codex', 'gemini', 'grok'] as const;
const STORAGE_CHOICES = ['ever-works-git', 'user-github', 'user-gitlab', 'user-git'] as const;
const DEPLOY_CHOICES = ['ever-works', 'vercel', 'k8s'] as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface WizardState {
    version: number;
    lastStep: number;
    ai: { choice: string };
    storage: { choice: string };
    deploy: { choice: string };
    skippedSteps: string[];
    pluginsReviewed: boolean;
    prompt?: string;
}

interface StateEnvelope {
    completedAt: string | null;
    dismissedAt: string | null;
    state: WizardState;
}

interface CatalogCard {
    choice: string;
    title: string;
    description: string;
    default: boolean;
    available: boolean;
    badges: string[];
    pluginId?: string;
}

interface PluginCard {
    pluginId: string;
    name: string;
    category: string;
    description: string;
    onboardingPriority: number;
}

interface Catalog {
    ai: CatalogCard[];
    storage: CatalogCard[];
    deploy: CatalogCard[];
    plugins: PluginCard[];
}

// ─── plane helpers (authenticated wizard) ───────────────────────────────────

async function getCatalog(request: APIRequestContext, token: string): Promise<Catalog> {
    const res = await request.get(`${API_BASE}/api/onboarding/catalog`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `catalog body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getState(request: APIRequestContext, token: string): Promise<StateEnvelope> {
    const res = await request.get(`${API_BASE}/api/onboarding/state`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `state body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** PATCH a partial state; asserts 200 and returns the envelope. */
async function patchState(
    request: APIRequestContext,
    token: string,
    state: Record<string, unknown>,
): Promise<StateEnvelope> {
    const res = await request.patch(`${API_BASE}/api/onboarding/state`, {
        headers: authedHeaders(token),
        data: { state },
    });
    expect(res.status(), `patch body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Raw PATCH for negative cases — returns { status, body } without asserting. */
async function rawPatch(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<{ status: number; body: { message?: unknown } }> {
    const res = await request.patch(`${API_BASE}/api/onboarding/state`, {
        headers: authedHeaders(token),
        data: body,
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
}

async function complete(request: APIRequestContext, token: string): Promise<StateEnvelope> {
    const res = await request.post(`${API_BASE}/api/onboarding/complete`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `complete body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function dismiss(request: APIRequestContext, token: string): Promise<StateEnvelope> {
    const res = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `dismiss body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function telemetry(
    request: APIRequestContext,
    token: string,
    event: string,
    properties?: Record<string, unknown>,
): Promise<number> {
    const res = await request.post(`${API_BASE}/api/onboarding/telemetry`, {
        headers: authedHeaders(token),
        data: properties ? { event, properties } : { event },
    });
    return res.status();
}

async function listWorkIds(request: APIRequestContext, token: string): Promise<string[]> {
    const res = await request.get(`${API_BASE}/api/works`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { works: Array<{ id: string }> };
    return body.works.map((w) => w.id);
}

/** Assert an envelope's state equals the canonical version-2 default. */
function expectDefaultState(env: StateEnvelope): void {
    expect(env.completedAt).toBeNull();
    expect(env.dismissedAt).toBeNull();
    expect(env.state).toEqual({
        version: 2,
        lastStep: 0,
        ai: { choice: 'ever-works' },
        storage: { choice: 'ever-works-git' },
        deploy: { choice: 'ever-works' },
        skippedSteps: [],
        pluginsReviewed: false,
    });
}

// ─── Cluster A — the catalog ↔ state contract (server-authoritative) ─────────

test.describe('Onboarding chain — catalog ↔ state default coherence', () => {
    test('a fresh user opens the wizard on the CANONICAL version-2 default (no timestamps, no prompt)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const env = await getState(request, user.access_token);
        expectDefaultState(env);
        // The optional landing-page prompt is ABSENT (not null) until set.
        expect('prompt' in env.state).toBe(false);
    });

    test('every catalog bucket has exactly ONE default, its default choice equals the persisted default, and "planned" appears IFF unavailable', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const catalog = await getCatalog(request, user.access_token);
        const fresh = (await getState(request, user.access_token)).state;

        const buckets: Array<[CatalogCard[], string]> = [
            [catalog.ai, fresh.ai.choice],
            [catalog.storage, fresh.storage.choice],
            [catalog.deploy, fresh.deploy.choice],
        ];
        for (const [cards, persistedDefault] of buckets) {
            const defaults = cards.filter((c) => c.default);
            expect(defaults).toHaveLength(1);
            // The wizard opens on the catalog default; the persisted default agrees.
            expect(defaults[0].choice).toBe(persistedDefault);
            // planned-iff-unavailable invariant holds for EVERY card, env-agnostic.
            for (const c of cards) {
                expect(c.badges.includes('planned')).toBe(c.available === false);
                expect(typeof c.title).toBe('string');
                expect(c.description.length).toBeGreaterThan(0);
            }
        }
        // The AI default is the one bucket default that is ALWAYS available.
        const aiDefault = catalog.ai.find((c) => c.default)!;
        expect(aiDefault.choice).toBe('ever-works');
        expect(aiDefault.available).toBe(true);
        expect(aiDefault.badges).toContain('default');
    });

    test('the catalog card choice-sets exactly match the state machine enums; BYOK/own cards carry a pluginId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const catalog = await getCatalog(request, user.access_token);

        expect(catalog.ai.map((c) => c.choice)).toEqual([...AI_CHOICES]);
        expect(catalog.storage.map((c) => c.choice)).toEqual([...STORAGE_CHOICES]);
        expect(catalog.deploy.map((c) => c.choice)).toEqual([...DEPLOY_CHOICES]);

        // A non-default card that names a plugin carries its pluginId; the default
        // Ever-Works card in each bucket never does.
        for (const cards of [catalog.ai, catalog.storage, catalog.deploy]) {
            for (const c of cards) {
                if (c.pluginId !== undefined) {
                    expect(typeof c.pluginId).toBe('string');
                    expect(c.pluginId.length).toBeGreaterThan(0);
                }
            }
        }
        // AI BYOK cards specifically carry the 'byok' badge + a pluginId.
        for (const c of catalog.ai.filter((x) => x.badges.includes('byok'))) {
            expect(c.default).toBe(false);
            expect(typeof c.pluginId).toBe('string');
        }
    });

    test('the plugins step is DISJOINT from every choice-card pluginId (reserved exclusion) and sorted by onboardingPriority', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const catalog = await getCatalog(request, user.access_token);

        const reserved = new Set(
            [...catalog.ai, ...catalog.storage, ...catalog.deploy]
                .map((c) => c.pluginId)
                .filter((id): id is string => Boolean(id)),
        );
        expect(reserved.has('github')).toBe(true);
        expect(reserved.has('vercel')).toBe(true);

        for (const p of catalog.plugins) {
            // No plugin card re-uses an AI/Storage/Deploy card's pluginId.
            expect(reserved.has(p.pluginId)).toBe(false);
            // Each plugin card is the full 5-field shape (distinct from a choice card).
            expect(typeof p.pluginId).toBe('string');
            expect(typeof p.name).toBe('string');
            expect(typeof p.category).toBe('string');
            expect(typeof p.description).toBe('string');
            expect(Number.isFinite(p.onboardingPriority)).toBe(true);
        }
        // Ascending by onboardingPriority.
        const priorities = catalog.plugins.map((p) => p.onboardingPriority);
        expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    });

    test('the catalog is SERVER-AUTHORITATIVE — byte-identical across two distinct users, and 401 anonymously', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const ca = await getCatalog(request, a.access_token);
        const cb = await getCatalog(request, b.access_token);
        // Not per-user — the payload does not depend on identity.
        expect(JSON.stringify(ca)).toBe(JSON.stringify(cb));

        const anon = await request.get(`${API_BASE}/api/onboarding/catalog`);
        expect(anon.status()).toBe(401);
    });
});

// ─── Cluster B — driving the choice alphabet ─────────────────────────────────

test.describe('Onboarding chain — the state machine consumes the catalog alphabet', () => {
    test('all six AI choices round-trip through PATCH→GET; a real-but-non-onboarding value is rejected with the exact enum', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        for (const choice of AI_CHOICES) {
            const patched = await patchState(request, token, { ai: { choice } });
            expect(patched.state.ai.choice).toBe(choice);
            expect(patched.state.version).toBe(2);
            // The GET reflects the same choice (persisted, not just echoed).
            expect((await getState(request, token)).state.ai.choice).toBe(choice);
        }

        // 'anthropic' is a real AI PLUGIN id but NOT an onboarding ai CHOICE.
        const bad = await rawPatch(request, token, { state: { ai: { choice: 'anthropic' } } });
        expect(bad.status).toBe(400);
        expect(msgOf(bad.body)).toMatch(/must be one of the following values/i);
        expect(msgOf(bad.body)).toContain('ever-works');
        // The last VALID choice (grok) survived the rejected write.
        expect((await getState(request, token)).state.ai.choice).toBe('grok');
    });

    test('every storage + deploy choice is accepted, INCLUDING the "planned"/unavailable ones (state machine ⟂ availability)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        for (const choice of STORAGE_CHOICES) {
            const env = await patchState(request, token, { storage: { choice } });
            expect(env.state.storage.choice).toBe(choice);
        }
        for (const choice of DEPLOY_CHOICES) {
            const env = await patchState(request, token, { deploy: { choice } });
            expect(env.state.deploy.choice).toBe(choice);
        }
        // 'user-gitlab' + 'ever-works' are catalog-"planned" in this env, yet the
        // state machine persisted them — availability never gates the choice.
        const finalState = (await getState(request, token)).state;
        expect(finalState.deploy.choice).toBe('k8s');
        expect(finalState.storage.choice).toBe('user-git');
    });

    test('the landing-page prompt is RETAINED across later patches that omit it, and a >5000-char prompt is rejected without corrupting it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const seeded = await patchState(request, token, {
            prompt: 'Build me a directory of AI tools',
        });
        expect(seeded.state.prompt).toBe('Build me a directory of AI tools');

        // Several unrelated hops that never mention `prompt` must not drop it.
        await patchState(request, token, { ai: { choice: 'openrouter' } });
        await patchState(request, token, { lastStep: 3 });
        const afterHops = await patchState(request, token, { pluginsReviewed: true });
        expect(afterHops.state.prompt).toBe('Build me a directory of AI tools');
        expect(afterHops.state.ai.choice).toBe('openrouter');

        // An over-cap prompt is rejected; the retained prompt is unchanged.
        const big = await rawPatch(request, token, { state: { prompt: 'x'.repeat(5001) } });
        expect(big.status).toBe(400);
        expect(msgOf(big.body)).toMatch(/shorter than or equal to 5000/i);
        expect((await getState(request, token)).state.prompt).toBe(
            'Build me a directory of AI tools',
        );
    });

    test('the state DTO is a CLOSED shape at three levels; each rejection leaves the persisted state intact', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        // Establish a known non-default anchor.
        await patchState(request, token, { ai: { choice: 'gemini' }, lastStep: 2 });

        // (1) unknown TOP-level body key.
        const topLevel = await rawPatch(request, token, { bogus: true });
        expect(topLevel.status).toBe(400);
        expect(msgOf(topLevel.body)).toMatch(/property bogus should not exist/i);

        // (2) unknown key INSIDE state.
        const stateLevel = await rawPatch(request, token, { state: { hacker: 'x' } });
        expect(stateLevel.status).toBe(400);
        expect(msgOf(stateLevel.body)).toMatch(/property hacker should not exist/i);

        // (3) unknown key NESTED inside a choice object.
        const nested = await rawPatch(request, token, {
            state: { ai: { choice: 'grok', evil: 1 } },
        });
        expect(nested.status).toBe(400);
        expect(msgOf(nested.body)).toMatch(/ai\.property evil should not exist/i);

        // A choice object with NO choice, and a negative lastStep, both 400.
        expect((await rawPatch(request, token, { state: { ai: {} } })).status).toBe(400);
        const negStep = await rawPatch(request, token, { state: { lastStep: -1 } });
        expect(negStep.status).toBe(400);
        expect(msgOf(negStep.body)).toMatch(/must not be less than 0/i);

        // NONE of the five rejections mutated the anchor.
        const after = (await getState(request, token)).state;
        expect(after.ai.choice).toBe('gemini');
        expect(after.lastStep).toBe(2);
    });

    test('skippedSteps REPLACES (never appends) and enforces its size + per-element bounds while choices coexist', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const first = await patchState(request, token, {
            skippedSteps: ['storage', 'deploy'],
            ai: { choice: 'codex' },
        });
        expect(first.state.skippedSteps).toEqual(['storage', 'deploy']);
        expect(first.state.ai.choice).toBe('codex');

        // A new array REPLACES the old one wholesale (deep-merge is by-key, not
        // element-append) — and the coexisting ai choice is untouched.
        const replaced = await patchState(request, token, { skippedSteps: ['plugins'] });
        expect(replaced.state.skippedSteps).toEqual(['plugins']);
        expect(replaced.state.ai.choice).toBe('codex');

        // >20 elements → ArrayMaxSize; a single >64-char element → per-element cap.
        const tooMany = await rawPatch(request, token, {
            state: { skippedSteps: Array.from({ length: 21 }, (_, i) => `s${i}`) },
        });
        expect(tooMany.status).toBe(400);
        expect(msgOf(tooMany.body)).toMatch(/no more than 20 elements/i);
        const tooLong = await rawPatch(request, token, {
            state: { skippedSteps: ['y'.repeat(65)] },
        });
        expect(tooLong.status).toBe(400);
        expect(msgOf(tooLong.body)).toMatch(/shorter than or equal to 64/i);

        // The last VALID skip list survived both rejected writes.
        expect((await getState(request, token)).state.skippedSteps).toEqual(['plugins']);
    });
});

// ─── Cluster C — the wizard's culmination: a first Work ──────────────────────

test.describe('Onboarding chain — from the wizard to the first Work', () => {
    test('a full journey: default → catalog choices → prompt → FIRST Work → complete leaves a coherent finished state', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // 0) opens on the default.
        expectDefaultState(await getState(request, token));

        // 1) walk the wizard: pick choices + carry the landing-page prompt, step by step.
        await patchState(request, token, { ai: { choice: 'openrouter' }, lastStep: 1 });
        await patchState(request, token, { storage: { choice: 'user-github' }, lastStep: 2 });
        await patchState(request, token, { deploy: { choice: 'vercel' }, lastStep: 3 });
        const configured = await patchState(request, token, {
            prompt: 'A curated directory of MCP servers',
            pluginsReviewed: true,
            lastStep: 4,
        });
        expect(configured.state).toMatchObject({
            version: 2,
            lastStep: 4,
            ai: { choice: 'openrouter' },
            storage: { choice: 'user-github' },
            deploy: { choice: 'vercel' },
            pluginsReviewed: true,
            prompt: 'A curated directory of MCP servers',
        });
        expect(configured.completedAt).toBeNull();

        // 2) the culmination — the user creates their FIRST Work.
        const work = await createWorkViaAPI(request, token, { name: `Onboarding Work ${stamp()}` });
        expect(work.id).toMatch(UUID_RE);
        const wRaw = work.raw as { status: string; work: { acceptedFromIdeaId: string | null } };
        expect(wRaw.status).toBe('success');
        // A first Work born from the wizard has NO source Idea (manual path).
        expect(wRaw.work.acceptedFromIdeaId).toBeNull();

        // 3) mark onboarding complete.
        const done = await complete(request, token);
        expect(done.completedAt).toMatch(ISO_RE);
        expect(done.dismissedAt).toBeNull();
        // The choices survive the complete transition untouched.
        expect(done.state.ai.choice).toBe('openrouter');
        expect(done.state.prompt).toBe('A curated directory of MCP servers');

        // 4) coherence: the Work reads back, and the user's works list is EXACTLY it.
        expect(
            (
                await request.get(`${API_BASE}/api/works/${work.id}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(200);
        expect(await listWorkIds(request, token)).toEqual([work.id]);
        // And the completed state is still readable on a fresh GET.
        expect((await getState(request, token)).completedAt).toBe(done.completedAt);
    });

    test('Work creation is INDEPENDENT of the onboarding lifecycle — a Work can precede any wizard interaction, and complete needs no Work', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Create a Work while onboarding is still in its untouched default.
        const work = await createWorkViaAPI(request, token, { name: `Early Work ${stamp()}` });
        expect(work.id).toMatch(UUID_RE);
        // Creating a Work did not silently advance/complete onboarding.
        expectDefaultState(await getState(request, token));

        // A second, Work-less user can still complete onboarding (no Work required).
        const soloUser = await registerUserViaAPI(request);
        const soloDone = await complete(request, soloUser.access_token);
        expect(soloDone.completedAt).toMatch(ISO_RE);
        expect(await listWorkIds(request, soloUser.access_token)).toEqual([]);
    });

    test('dismiss then complete accumulate around a mid-journey Work; both are idempotent and the Work persists', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const dismissed = await dismiss(request, token);
        expect(dismissed.dismissedAt).toMatch(ISO_RE);
        expect(dismissed.completedAt).toBeNull();

        const work = await createWorkViaAPI(request, token, { name: `Mid Work ${stamp()}` });

        const done = await complete(request, token);
        expect(done.completedAt).toMatch(ISO_RE);
        // The earlier dismiss timestamp is preserved alongside the new complete one.
        expect(done.dismissedAt).toBe(dismissed.dismissedAt);

        // Both transitions are idempotent — repeating each returns the SAME instant.
        expect((await complete(request, token)).completedAt).toBe(done.completedAt);
        expect((await dismiss(request, token)).dismissedAt).toBe(dismissed.dismissedAt);

        // The mid-journey Work is untouched by the lifecycle transitions.
        expect(
            (
                await request.get(`${API_BASE}/api/works/${work.id}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(200);
    });

    test('completedAt is MONOTONIC — a second Work (and a rejected dup-slug create) never re-stamps it', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const first = await createWorkViaAPI(request, token, { name: `First ${stamp()}` });
        const done = await complete(request, token);
        const at = done.completedAt;
        expect(at).toMatch(ISO_RE);

        // A dup-slug create is rejected (400) and mints nothing.
        const slug = `dup-${stamp()}`;
        await createWorkViaAPI(request, token, { name: `Uniq ${stamp()}`, slug });
        const dup = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(token),
            data: { name: 'Dup', slug, description: 'd', organization: false },
        });
        expect(dup.status()).toBe(400);

        // A second (valid) Work + a repeat complete leave completedAt frozen.
        await createWorkViaAPI(request, token, { name: `Second ${stamp()}` });
        expect((await complete(request, token)).completedAt).toBe(at);
        expect((await getState(request, token)).completedAt).toBe(at);
        // The works list now carries the first + the two later works (never the dup).
        expect((await listWorkIds(request, token)).length).toBe(3);
        expect(await listWorkIds(request, token)).toContain(first.id);
    });
});

// ─── Cluster D — the two onboarding planes are decoupled ─────────────────────

test.describe('Onboarding chain — authenticated wizard plane vs public agent plane', () => {
    test('register-work is gated on X-GitHub-Token, NOT the Bearer session — a Bearer is neither required nor sufficient', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Bearer present but NO X-GitHub-Token → the header-required 400, not a 401.
        const noGh = await request.post(`${API_BASE}/api/register-work`, {
            headers: authedHeaders(token),
            data: { repo: 'https://github.com/octocat/hello-world' },
        });
        expect(noGh.status()).toBe(400);
        const noGhBody = (await noGh.json()) as { code?: string; message?: string };
        expect(noGhBody.code).toBe('validation_error');
        expect(noGhBody.message).toMatch(/x-github-token/i);

        // A bad repo (Bearer present, GH token present) → class-validator array 400,
        // and the feature is ON (never the 404 feature_disabled envelope).
        const badRepo = await request.post(`${API_BASE}/api/register-work`, {
            headers: { ...authedHeaders(token), 'X-GitHub-Token': 'ghp_fake_abcdef' },
            data: { repo: 'not-a-github-url' },
        });
        expect(badRepo.status()).toBe(400);
        expect(msgOf(await badRepo.json())).toMatch(/must be a https:\/\/github\.com/i);
    });

    test('a register-work attempt that fails the credential gate mints NOTHING and leaves the caller’s onboarding_state untouched', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Seed a distinctive wizard state on the authenticated plane.
        const seeded = await patchState(request, token, {
            ai: { choice: 'claude-code' },
            lastStep: 2,
            prompt: 'cross-plane isolation probe',
        });

        // An unresolvable token on the agent plane → 403 gh_credential_invalid.
        const attempt = await request.post(`${API_BASE}/api/register-work`, {
            headers: { ...authedHeaders(token), 'X-GitHub-Token': 'ghp_fake_abcdef' },
            data: { repo: 'https://github.com/octocat/hello-world' },
        });
        expect(attempt.status()).toBe(403);
        expect((await attempt.json()).code).toBe('gh_credential_invalid');

        // A token shorter than 4 chars trips the malformed pre-check → 401.
        const shortTok = await request.post(`${API_BASE}/api/register-work`, {
            headers: { 'X-GitHub-Token': 'ab' },
            data: { repo: 'https://github.com/octocat/hello-world' },
        });
        expect(shortTok.status()).toBe(401);

        // The wizard plane is entirely undisturbed by the agent-plane failures.
        const after = await getState(request, token);
        expect(after.state).toEqual(seeded.state);
        expect(after.completedAt).toBeNull();
        expect(after.dismissedAt).toBeNull();
    });

    test('the auth boundary DIVERGES between planes — the wizard plane is 401 anon while register-work is Public (never 401)', async ({
        request,
    }) => {
        // Wizard plane: every endpoint rejects the anonymous caller with 401.
        expect((await request.get(`${API_BASE}/api/onboarding/catalog`)).status()).toBe(401);
        expect((await request.get(`${API_BASE}/api/onboarding/state`)).status()).toBe(401);
        expect(
            (
                await request.patch(`${API_BASE}/api/onboarding/state`, { data: { state: {} } })
            ).status(),
        ).toBe(401);
        expect((await request.post(`${API_BASE}/api/onboarding/complete`)).status()).toBe(401);
        expect((await request.post(`${API_BASE}/api/onboarding/dismiss`)).status()).toBe(401);
        expect(
            (
                await request.post(`${API_BASE}/api/onboarding/telemetry`, {
                    data: { event: 'onboarding_opened' },
                })
            ).status(),
        ).toBe(401);

        // Agent plane: Public — it answers with typed 400/403/404, NEVER 401.
        const postAnon = await request.post(`${API_BASE}/api/register-work`, {
            data: { repo: 'https://github.com/octocat/hello-world' },
        });
        expect(postAnon.status()).toBe(400); // missing token, not "unauthorized"
        expect(postAnon.status()).not.toBe(401);

        const getAnon = await request.get(`${API_BASE}/api/register-work/${UNKNOWN_UUID}`);
        expect(getAnon.status()).toBe(403); // token-required, not "unauthorized"
        expect(getAnon.status()).not.toBe(401);
        // Non-uuid id on the public GET → ParseUUIDPipe 400 (validation precedes handler).
        expect((await request.get(`${API_BASE}/api/register-work/not-a-uuid`)).status()).toBe(400);
    });
});

// ─── Cluster E — telemetry mirrors, but never drives, the state machine ──────

test.describe('Onboarding chain — telemetry is observational, PATCH is authoritative', () => {
    test('emitting choice-selected telemetry does NOT persist the choice — only PATCH does; a bad event 400s and never blocks the chain', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Fire the wizard's choice telemetry BEFORE any PATCH.
        expect(
            await telemetry(request, token, 'onboarding_ai_choice_selected', { choice: 'grok' }),
        ).toBe(204);
        expect(
            await telemetry(request, token, 'onboarding_deploy_choice_selected', {
                choice: 'k8s',
            }),
        ).toBe(204);

        // Telemetry is observational: the state is still the untouched default.
        expectDefaultState(await getState(request, token));

        // Only the PATCH actually moves the machine.
        const patched = await patchState(request, token, { ai: { choice: 'grok' } });
        expect(patched.state.ai.choice).toBe('grok');

        // A bad event 400s (enumerating the allow-list) but never blocks a following
        // valid PATCH + complete.
        const badEvent = await request.post(`${API_BASE}/api/onboarding/telemetry`, {
            headers: authedHeaders(token),
            data: { event: 'totally_made_up' },
        });
        expect(badEvent.status()).toBe(400);
        expect(msgOf(await badEvent.json())).toMatch(/onboarding_opened/);

        const done = await complete(request, token);
        expect(done.completedAt).toMatch(ISO_RE);
        expect(done.state.ai.choice).toBe('grok');
    });

    test('a full valid telemetry funnel returns 204 with an empty body and never mutates the accumulated state', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Build a real accumulated state first.
        const before = await patchState(request, token, {
            ai: { choice: 'openrouter' },
            lastStep: 3,
            skippedSteps: ['plugins'],
        });

        const funnel = [
            'onboarding_opened',
            'onboarding_step_viewed',
            'onboarding_step_next',
            'onboarding_ai_choice_selected',
            'onboarding_plugins_step_skipped',
            'onboarding_completed',
        ];
        for (const event of funnel) {
            const res = await request.post(`${API_BASE}/api/onboarding/telemetry`, {
                headers: authedHeaders(token),
                data: { event, properties: { at: Date.now() } },
            });
            expect(res.status(), `event=${event}`).toBe(204);
            expect((await res.text()).length).toBe(0);
        }

        // The whole funnel left completedAt/lastStep/choices pristine.
        const after = await getState(request, token);
        expect(after.completedAt).toBeNull();
        expect(after.state).toEqual(before.state);
    });
});

// ─── Cluster F — per-user isolation of the whole chain ───────────────────────

test.describe('Onboarding chain — isolation across users', () => {
    test('two users own independent wizard states + first Works; one user’s choices/complete never leak into the other', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);

        // Alice walks the wizard, creates a Work, and completes.
        await patchState(request, alice.access_token, {
            ai: { choice: 'gemini' },
            deploy: { choice: 'k8s' },
            lastStep: 4,
        });
        const aliceWork = await createWorkViaAPI(request, alice.access_token, {
            name: `Alice Work ${stamp()}`,
        });
        const aliceDone = await complete(request, alice.access_token);
        expect(aliceDone.completedAt).toMatch(ISO_RE);

        // Bob is entirely unaffected: default state, no completedAt, empty works.
        const bobState = await getState(request, bob.access_token);
        expectDefaultState(bobState);
        expect(await listWorkIds(request, bob.access_token)).toEqual([]);

        // Alice's own state + works are exactly what she set.
        const aliceState = await getState(request, alice.access_token);
        expect(aliceState.state.ai.choice).toBe('gemini');
        expect(aliceState.state.deploy.choice).toBe('k8s');
        expect(aliceState.completedAt).toBe(aliceDone.completedAt);
        expect(await listWorkIds(request, alice.access_token)).toEqual([aliceWork.id]);
    });

    test('a first Work is walled off from other users — a stranger’s list never sees it and a direct read is refused', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);

        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Owner Work ${stamp()}`,
        });
        // The stranger's works list is empty; the owner's contains exactly the Work.
        expect(await listWorkIds(request, stranger.access_token)).toEqual([]);
        expect(await listWorkIds(request, owner.access_token)).toContain(work.id);

        // A direct cross-user read of the Work is refused (403/404 — no leak).
        const crossRead = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect([403, 404]).toContain(crossRead.status());

        // Anonymous list is a hard 401.
        expect((await request.get(`${API_BASE}/api/works`)).status()).toBe(401);
    });
});
