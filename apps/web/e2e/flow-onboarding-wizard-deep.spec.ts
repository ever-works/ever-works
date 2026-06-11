import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-onboarding-wizard-deep.spec.ts — DEEP, multi-step, cross-feature
 * integration flows for the v2 onboarding wizard (EW-617) that intentionally
 * do NOT overlap `flow-onboarding-wizard.spec.ts` (catalog stepping / dismiss
 * + complete idempotency / telemetry funnel) nor the shallow round-trips in
 * `onboarding-wizard-v2.spec.ts` / `onboarding-deeper.spec.ts`.
 *
 * Every contract below was probe-verified against the LIVE CI API at :3100
 * (NestJS, sqlite in-memory) on a throwaway registered user:
 *
 *   GET  /api/onboarding/state   → 200 { completedAt, dismissedAt, state:V2 }
 *                                  (401 unauth). Fresh user is the documented
 *                                  ONBOARDING_DEFAULT_STATE.
 *   PATCH /api/onboarding/state  → 200, DEEP-MERGES partial `{ state }`:
 *      • empty body `{}`                → 200 no-op echoing current state
 *      • patching ONLY `lastStep`       → preserves ai/storage/deploy/
 *                                         skippedSteps[]/pluginsReviewed
 *      • `{ state:{ ai:{} } }`          → 400 "state.ai.choice must be one of
 *                                         the following values: …" (nested
 *                                         choice is REQUIRED once `ai` present)
 *      • `{ state:{ prompt:'…' } }`     → 200 persisted. EW-722 (security
 *                                         wave M): the contract-declared
 *                                         `prompt` is now whitelisted in the
 *                                         DTO with @MaxLength(5000); an
 *                                         OVERSIZED prompt (>5000) → 400.
 *      • unknown field                  → 400 "…should not exist"
 *      • `lastStep:-3`                  → 400 "must not be less than 0"
 *      • `lastStep:2.5`                 → 400 "must be an integer number"
 *      • `lastStep:9999`                → 200 stored RAW (server does NOT clamp;
 *                                         clamping is the client's job).
 *      • `skippedSteps:[123]`           → 400 "each value … must be a string"
 *      • concurrent racing patches      → last-write-wins (no 409/lock)
 *   POST /api/onboarding/complete → 200 sets completedAt (idempotent). Does
 *                                   NOT block a subsequent dismiss.
 *   POST /api/onboarding/dismiss  → 200 sets dismissedAt (idempotent).
 *   POST /api/onboarding/telemetry→ 204 allow-listed; 400 otherwise. When
 *                                   BOTH the event AND properties are bad the
 *                                   400 body lists BOTH messages. Telemetry
 *                                   NEVER mutates onboarding state.
 *   GET  /api/onboarding/catalog  → 200 { ai[6], storage[4], deploy[3],
 *                                   plugins[] }. Each bucket has exactly one
 *                                   `default:true`. `available:false` cards
 *                                   ALWAYS carry the 'planned' badge. AI BYOK
 *                                   cards carry 'byok'. Plugins are sorted by
 *                                   ascending `onboardingPriority` and never
 *                                   include a pluginId already reserved by an
 *                                   ai/storage/deploy card.
 *
 * ENVIRONMENT-ADAPTIVE: in THIS CI stack the Ever Works managed git/deploy
 * env-flags are OFF, so the `ever-works-git` storage and `ever-works` deploy
 * DEFAULT cards report `available:false` + badge 'planned'. These flows never
 * hard-code that — they derive availability from the live catalog so they pass
 * whether or not an operator flips the flags.
 *
 * STEP DERIVATION: faithful inline copy of `computeStepList`
 * (apps/web/src/components/onboarding/useOnboardingFlow.ts) — config sub-steps
 * appear only for non-default choices (ai≠ever-works; storage=user-github;
 * deploy∈{vercel,k8s}). Base flow = 6 steps; full BYOK = 9.
 *
 * BADGE / AUTO-OPEN: faithful inline copy of the predicates in
 * `app/[locale]/(dashboard)/layout-client.tsx`:
 *   shouldAutoOpen = totalWorks===0 && !dismissedAt && !completedAt
 *   showBadge      = totalWorks===0 &&  dismissedAt && !completedAt
 *   currentStep    = min(lastStep+1, totalSteps)   // client clamps the badge
 *
 * Isolation: ALL orchestration runs on FRESH registerUserViaAPI() users so the
 * shared in-memory DB stays clean and sibling specs are unaffected.
 */

// ─── Wire types (subset of @ever-works/contracts/api) ────────────────────────

type AiChoice = 'ever-works' | 'openrouter' | 'claude-code' | 'codex' | 'gemini' | 'grok';
type StorageChoice = 'ever-works-git' | 'user-github' | 'user-gitlab' | 'user-git';
type DeployChoice = 'ever-works' | 'vercel' | 'k8s';

interface WizardStateV2 {
    version: 2;
    lastStep: number;
    ai: { choice: AiChoice };
    storage: { choice: StorageChoice };
    deploy: { choice: DeployChoice };
    skippedSteps: string[];
    pluginsReviewed: boolean;
}

interface StateResponse {
    completedAt: string | null;
    dismissedAt: string | null;
    state: WizardStateV2;
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

interface CatalogResponse {
    ai: CatalogCard[];
    storage: CatalogCard[];
    deploy: CatalogCard[];
    plugins: Array<{
        pluginId: string;
        name: string;
        category: string;
        description: string;
        onboardingPriority: number;
    }>;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

const ONB = {
    state: `${API_BASE}/api/onboarding/state`,
    catalog: `${API_BASE}/api/onboarding/catalog`,
    complete: `${API_BASE}/api/onboarding/complete`,
    dismiss: `${API_BASE}/api/onboarding/dismiss`,
    telemetry: `${API_BASE}/api/onboarding/telemetry`,
} as const;

// ─── Step derivation (faithful copy of computeStepList) ──────────────────────

function computeStepIds(state: Pick<WizardStateV2, 'ai' | 'storage' | 'deploy'>): string[] {
    const ids: string[] = ['welcome', 'ai-choice'];
    if (state.ai.choice !== 'ever-works') ids.push(`ai-config:${state.ai.choice}`);
    ids.push('storage-choice');
    if (state.storage.choice === 'user-github') ids.push(`storage-config:${state.storage.choice}`);
    ids.push('deploy-choice');
    if (state.deploy.choice === 'vercel' || state.deploy.choice === 'k8s') {
        ids.push(`deploy-config:${state.deploy.choice}`);
    }
    ids.push('plugins-catalog', 'create-work');
    return ids;
}

// ─── Badge / auto-open predicates (faithful copy of layout-client.tsx) ───────

function shouldAutoOpen(s: StateResponse, totalWorks: number): boolean {
    return totalWorks === 0 && !s.dismissedAt && !s.completedAt;
}

function showBadge(s: StateResponse, totalWorks: number): boolean {
    return totalWorks === 0 && Boolean(s.dismissedAt) && !s.completedAt;
}

/** Client-side badge "x of N": lastStep+1 clamped to the derived total. */
function badgeCurrentStep(s: StateResponse): { current: number; total: number } {
    const total = computeStepIds(s.state).length;
    return { current: Math.min(s.state.lastStep + 1, total), total };
}

// ─── API helpers (inline — no product helper exists for onboarding) ──────────

async function getState(request: APIRequestContext, token: string): Promise<StateResponse> {
    const res = await request.get(ONB.state, { headers: authedHeaders(token) });
    expect(res.status(), `GET state body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function patchState(
    request: APIRequestContext,
    token: string,
    state: Record<string, unknown>,
): Promise<StateResponse> {
    const res = await request.patch(ONB.state, {
        headers: authedHeaders(token),
        data: { state },
    });
    expect(res.status(), `PATCH state body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function patchExpect400(
    request: APIRequestContext,
    token: string,
    body: unknown,
): Promise<string> {
    const res = await request.patch(ONB.state, { headers: authedHeaders(token), data: body });
    expect(res.status(), `expected 400 for ${JSON.stringify(body)}`).toBe(400);
    return JSON.stringify(await res.json());
}

async function getCatalog(request: APIRequestContext, token: string): Promise<CatalogResponse> {
    const res = await request.get(ONB.catalog, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    return res.json();
}

// ─── Flow 1: deep-merge integrity over a long interleaved mutation sequence ──

test.describe('Onboarding deep — partial deep-merge never clobbers sibling fields', () => {
    test('a long interleaved sequence of nested/array/scalar patches preserves every untouched field', async ({
        request,
    }) => {
        const token = (await registerUserViaAPI(request)).access_token;

        // Pristine baseline (probe-verified default state).
        const p = await getState(request, token);
        expect(p.state).toMatchObject({
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'ever-works' },
            skippedSteps: [],
            pluginsReviewed: false,
        });

        // 1) Patch ONLY ai.choice (nested-replace). storage/deploy/lastStep/
        //    skippedSteps must remain at their defaults.
        const s1 = await patchState(request, token, { ai: { choice: 'codex' } });
        expect(s1.state.ai.choice).toBe('codex');
        expect(s1.state.storage.choice).toBe('ever-works-git');
        expect(s1.state.deploy.choice).toBe('ever-works');
        expect(s1.state.lastStep).toBe(0);
        expect(s1.state.skippedSteps).toEqual([]);

        // 2) Patch ONLY skippedSteps[] — ai.choice from step 1 must survive
        //    (array set, scalars untouched).
        const s2 = await patchState(request, token, {
            skippedSteps: ['plugins-catalog', 'welcome'],
        });
        expect(s2.state.skippedSteps).toEqual(['plugins-catalog', 'welcome']);
        expect(s2.state.ai.choice).toBe('codex');

        // 3) Patch ONLY lastStep — the array AND the earlier ai choice survive
        //    (the headline deep-merge invariant; probe-verified).
        const s3 = await patchState(request, token, { lastStep: 5 });
        expect(s3.state.lastStep).toBe(5);
        expect(s3.state.skippedSteps).toEqual(['plugins-catalog', 'welcome']);
        expect(s3.state.ai.choice).toBe('codex');
        expect(s3.state.storage.choice).toBe('ever-works-git');

        // 4) Patch ONLY pluginsReviewed — everything else holds.
        const s4 = await patchState(request, token, { pluginsReviewed: true });
        expect(s4.state.pluginsReviewed).toBe(true);
        expect(s4.state.lastStep).toBe(5);
        expect(s4.state.ai.choice).toBe('codex');
        expect(s4.state.skippedSteps).toEqual(['plugins-catalog', 'welcome']);

        // 5) Multi-field patch that flips two buckets at once and grows the
        //    derived step list. AI choice (codex) is NOT in this patch and must
        //    persist.
        const s5 = await patchState(request, token, {
            storage: { choice: 'user-github' },
            deploy: { choice: 'k8s' },
            lastStep: 7,
        });
        expect(s5.state.storage.choice).toBe('user-github');
        expect(s5.state.deploy.choice).toBe('k8s');
        expect(s5.state.ai.choice).toBe('codex');
        expect(s5.state.lastStep).toBe(7);
        expect(s5.state.pluginsReviewed).toBe(true);

        // The derived step list now contains all three config sub-steps → 9.
        expect(computeStepIds(s5.state)).toEqual([
            'welcome',
            'ai-choice',
            'ai-config:codex',
            'storage-choice',
            'storage-config:user-github',
            'deploy-choice',
            'deploy-config:k8s',
            'plugins-catalog',
            'create-work',
        ]);

        // 6) An empty `{}` PATCH is an idempotent no-op (probe-verified: 200,
        //    echoes the current merged state unchanged — does NOT reset).
        const noop = await request.patch(ONB.state, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(noop.status()).toBe(200);
        const noopBody = (await noop.json()) as StateResponse;
        expect(noopBody.state).toEqual(s5.state);

        // A final independent GET proves the entire sequence persisted (the v2
        // "survives a device switch" design goal).
        const persisted = await getState(request, token);
        expect(persisted.state).toEqual(s5.state);
        expect(persisted.completedAt).toBeNull();
        expect(persisted.dismissedAt).toBeNull();
    });

    test('malformed partials are rejected without corrupting the persisted state', async ({
        request,
    }) => {
        const token = (await registerUserViaAPI(request)).access_token;

        // Seed a known-good non-default state we can prove is untouched after
        // every rejection.
        await patchState(request, token, {
            ai: { choice: 'openrouter' },
            storage: { choice: 'user-github' },
            lastStep: 3,
            skippedSteps: ['welcome'],
        });

        // (a) Nested `ai` present but WITHOUT `choice` → 400. The nested DTO
        //     makes `choice` required once the object is supplied (probe).
        const aiEmpty = await patchExpect400(request, token, { state: { ai: {} } });
        expect(aiEmpty).toContain('state.ai.choice must be one of the following values');

        // (b) EW-722 (security wave M): `prompt` is now whitelisted in the DTO
        //     with the contract's @MaxLength(5000) bound and persisted, closing
        //     the former DTO⟂type drift. The malformed probe is therefore an
        //     OVERSIZED prompt — rejected so user-controlled text cannot bloat
        //     the onboarding_state column.
        const prompt = await patchExpect400(request, token, {
            state: { prompt: 'x'.repeat(5001) },
        });
        expect(prompt).toContain('prompt must be shorter than or equal to 5000 characters');

        // (c) Unknown field → forbidNonWhitelisted 400.
        const unknown = await patchExpect400(request, token, { state: { bogusField: true } });
        expect(unknown).toContain('should not exist');

        // (d) Negative lastStep → @Min(0).
        const neg = await patchExpect400(request, token, { state: { lastStep: -3 } });
        expect(neg).toContain('must not be less than 0');

        // (e) Non-integer lastStep → @IsInt.
        const frac = await patchExpect400(request, token, { state: { lastStep: 2.5 } });
        expect(frac).toContain('must be an integer number');

        // (f) skippedSteps with a non-string element → @IsString({each:true}).
        const badArr = await patchExpect400(request, token, { state: { skippedSteps: [123] } });
        expect(badArr).toContain('each value in skippedSteps must be a string');

        // None of the six rejections mutated the persisted state.
        const after = await getState(request, token);
        expect(after.state.ai.choice).toBe('openrouter');
        expect(after.state.storage.choice).toBe('user-github');
        expect(after.state.lastStep).toBe(3);
        expect(after.state.skippedSteps).toEqual(['welcome']);
    });
});

// ─── Flow 2: catalog ↔ choice contract integrity matrix ──────────────────────

test.describe('Onboarding deep — catalog cards round-trip as valid PATCH choices', () => {
    test('every catalog choice is a valid state choice; planned/byok/default badges and plugin sort are consistent', async ({
        request,
    }) => {
        const token = (await registerUserViaAPI(request)).access_token;
        const catalog = await getCatalog(request, token);

        // Bucket sizes are fixed by the controller (probe-verified).
        expect(catalog.ai).toHaveLength(6);
        expect(catalog.storage).toHaveLength(4);
        expect(catalog.deploy).toHaveLength(3);

        // Exactly one default per bucket.
        for (const [name, cards] of [
            ['ai', catalog.ai],
            ['storage', catalog.storage],
            ['deploy', catalog.deploy],
        ] as const) {
            expect(
                cards.filter((c) => c.default),
                `${name} must have exactly one default`,
            ).toHaveLength(1);
        }
        // The single default per bucket is the canonical Ever Works option.
        expect(catalog.ai.find((c) => c.default)!.choice).toBe('ever-works');
        expect(catalog.storage.find((c) => c.default)!.choice).toBe('ever-works-git');
        expect(catalog.deploy.find((c) => c.default)!.choice).toBe('ever-works');

        // Badge invariants (environment-adaptive — `available` is env-flag
        // driven in this CI stack, so we assert the relationship, not the flag):
        //   • any unavailable card MUST carry the 'planned' badge
        //   • any AI BYOK card MUST carry 'byok' and reference a pluginId
        for (const card of [...catalog.ai, ...catalog.storage, ...catalog.deploy]) {
            if (!card.available) {
                expect(card.badges, `${card.choice} unavailable → planned`).toContain('planned');
            }
            if (card.badges.includes('default')) {
                expect(card.default, `${card.choice} 'default' badge ⇒ default:true`).toBe(true);
            }
        }
        for (const aiCard of catalog.ai) {
            if (aiCard.badges.includes('byok')) {
                expect(aiCard.available).toBe(true);
                expect(aiCard.pluginId, `${aiCard.choice} byok ⇒ pluginId`).toBeTruthy();
            }
        }

        // Plugins step never re-lists a pluginId already used by an
        // ai/storage/deploy card, and is sorted by ascending priority.
        const reserved = new Set(
            [...catalog.ai, ...catalog.storage, ...catalog.deploy]
                .map((c) => c.pluginId)
                .filter((x): x is string => Boolean(x)),
        );
        for (const plugin of catalog.plugins) {
            expect(reserved.has(plugin.pluginId), `${plugin.pluginId} must not be reserved`).toBe(
                false,
            );
        }
        const priorities = catalog.plugins.map((p) => p.onboardingPriority);
        expect(priorities).toEqual([...priorities].sort((a, b) => a - b));

        // CONTRACT ROUND-TRIP: every catalog `choice` must be accepted by the
        // state PATCH endpoint (the catalog can never surface a card the wizard
        // can't persist). We patch each bucket through all its catalog choices.
        for (const card of catalog.ai) {
            const r = await patchState(request, token, { ai: { choice: card.choice } });
            expect(r.state.ai.choice).toBe(card.choice);
        }
        for (const card of catalog.storage) {
            const r = await patchState(request, token, { storage: { choice: card.choice } });
            expect(r.state.storage.choice).toBe(card.choice);
        }
        for (const card of catalog.deploy) {
            const r = await patchState(request, token, { deploy: { choice: card.choice } });
            expect(r.state.deploy.choice).toBe(card.choice);
        }

        // Conversely, a fabricated choice NOT in the catalog enum is rejected.
        const fabricated = await patchExpect400(request, token, {
            state: { ai: { choice: 'totally-made-up-provider' } },
        });
        expect(fabricated).toContain('must be one of the following values');

        // The last accepted patch (last deploy card) is what persisted.
        const persisted = await getState(request, token);
        expect(persisted.state.deploy.choice).toBe(
            catalog.deploy[catalog.deploy.length - 1].choice,
        );
    });
});

// ─── Flow 3: lastStep stored raw server-side; client clamps the badge maths ──

test.describe('Onboarding deep — server stores lastStep raw, client clamps the badge', () => {
    test('an out-of-range lastStep persists raw but the badge clamps to the derived total across step-list lengths', async ({
        request,
    }) => {
        const token = (await registerUserViaAPI(request)).access_token;

        // All-defaults derived flow = 6 steps. Store a wildly out-of-range
        // lastStep (probe-verified: the SERVER does not clamp — it round-trips
        // 9999 verbatim; clamping lives in the client `computeStepList`/badge).
        await patchState(request, token, { lastStep: 9999 });
        const dismissRes = await request.post(ONB.dismiss, { headers: authedHeaders(token) });
        expect(dismissRes.status()).toBe(200);

        const defaultState = await getState(request, token);
        expect(defaultState.state.lastStep).toBe(9999); // raw, un-clamped
        expect(showBadge(defaultState, 0)).toBe(true);

        // The badge "x of N" must clamp current to the total even though the
        // stored lastStep is absurd. Defaults → 6 steps → badge reads "6/6".
        const defaultBadge = badgeCurrentStep(defaultState);
        expect(defaultBadge.total).toBe(6);
        expect(defaultBadge.current).toBe(6);

        // Now widen the derived flow to 9 by choosing all BYOK, with a sane
        // mid-flow lastStep. The badge should read "<lastStep+1>/9".
        const wide = await patchState(request, token, {
            ai: { choice: 'gemini' },
            storage: { choice: 'user-github' },
            deploy: { choice: 'vercel' },
            lastStep: 6,
        });
        expect(computeStepIds(wide.state)).toHaveLength(9);
        const wideState = await getState(request, token);
        const wideBadge = badgeCurrentStep(wideState);
        expect(wideBadge.total).toBe(9);
        expect(wideBadge.current).toBe(7); // min(6+1, 9)

        // Shrinking the flow back to 6 (all defaults) while lastStep stays 6
        // must re-clamp the badge to "6/6" — the total drives the ceiling.
        const narrowed = await patchState(request, token, {
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'ever-works' },
        });
        expect(narrowed.state.lastStep).toBe(6); // lastStep unchanged by this patch
        expect(computeStepIds(narrowed.state)).toHaveLength(6);
        const narrowedBadge = badgeCurrentStep(await getState(request, token));
        expect(narrowedBadge.total).toBe(6);
        expect(narrowedBadge.current).toBe(6); // min(6+1, 6) clamps to 6
    });
});

// ─── Flow 4: complete-then-dismiss ordering + the 4-state auto-open/badge SM ─

test.describe('Onboarding deep — auto-open/badge state machine across complete↔dismiss orderings', () => {
    test('completing FIRST suppresses the badge; a later dismiss cannot revive it (reverse of dismiss→complete)', async ({
        request,
    }) => {
        const token = (await registerUserViaAPI(request)).access_token;

        // State A: pristine fresh user, no works → AUTO-OPEN, no badge.
        const a = await getState(request, token);
        expect(shouldAutoOpen(a, 0)).toBe(true);
        expect(showBadge(a, 0)).toBe(false);

        // Make progress so we can prove complete/dismiss preserve it.
        await patchState(request, token, { ai: { choice: 'grok' }, lastStep: 4 });

        // State B: COMPLETE first (this spec's distinguishing ordering — the
        // sibling spec does dismiss→complete). Completed users never auto-open
        // and never show the badge, regardless of dismissed.
        const completeRes = await request.post(ONB.complete, { headers: authedHeaders(token) });
        expect(completeRes.status()).toBe(200);
        const b = (await completeRes.json()) as StateResponse;
        expect(b.completedAt).not.toBeNull();
        expect(b.dismissedAt).toBeNull();
        expect(b.state.ai.choice).toBe('grok'); // progress preserved
        expect(b.state.lastStep).toBe(4);
        expect(shouldAutoOpen(b, 0)).toBe(false);
        expect(showBadge(b, 0)).toBe(false);

        // State C: now DISMISS. dismissedAt is set but, because completedAt is
        // already non-null, the badge predicate (which requires !completedAt)
        // stays false. A completed wizard can never be "revived" into a badge.
        const dismissRes = await request.post(ONB.dismiss, { headers: authedHeaders(token) });
        expect(dismissRes.status()).toBe(200);
        const c = (await dismissRes.json()) as StateResponse;
        expect(c.completedAt).toBe(b.completedAt); // unchanged & idempotent
        expect(c.dismissedAt).not.toBeNull();
        expect(showBadge(c, 0)).toBe(false);
        expect(shouldAutoOpen(c, 0)).toBe(false);

        // Both timestamps are idempotent under repeat in this order, too.
        const complete2 = (await (
            await request.post(ONB.complete, { headers: authedHeaders(token) })
        ).json()) as StateResponse;
        const dismiss2 = (await (
            await request.post(ONB.dismiss, { headers: authedHeaders(token) })
        ).json()) as StateResponse;
        expect(complete2.completedAt).toBe(b.completedAt);
        expect(dismiss2.dismissedAt).toBe(c.dismissedAt);

        // Final GET: full 2x2 truth table for a never-works user is realised —
        // (dismissed=T, completed=T) is the terminal "no badge, no auto-open".
        const final = await getState(request, token);
        expect(Boolean(final.dismissedAt)).toBe(true);
        expect(Boolean(final.completedAt)).toBe(true);
        expect(shouldAutoOpen(final, 0)).toBe(false);
        expect(showBadge(final, 0)).toBe(false);
        // And even a user WITH works never auto-opens (the totalWorks gate).
        expect(shouldAutoOpen(final, 3)).toBe(false);
    });

    test('the badge-only state (dismissed, not completed) is reachable and labels correctly', async ({
        request,
    }) => {
        const token = (await registerUserViaAPI(request)).access_token;

        // Advance to the plugins step (index 4 of the 6-step default flow),
        // then dismiss WITHOUT completing → the "show badge" quadrant.
        await patchState(request, token, { lastStep: 4 });
        const dismissRes = await request.post(ONB.dismiss, { headers: authedHeaders(token) });
        expect(dismissRes.status()).toBe(200);

        const s = await getState(request, token);
        expect(showBadge(s, 0)).toBe(true);
        expect(shouldAutoOpen(s, 0)).toBe(false);

        const badge = badgeCurrentStep(s);
        expect(badge.total).toBe(6);
        expect(badge.current).toBe(5); // min(4+1, 6)

        // A user with at least one work leaves the badge quadrant entirely
        // (the totalWorks gate is shared by both predicates).
        expect(showBadge(s, 1)).toBe(false);
    });
});

// ─── Flow 5: telemetry validation precedence + skip funnel mirrors state ─────

test.describe('Onboarding deep — telemetry precedence + skip funnel correlated with skippedSteps', () => {
    test('combined-invalid telemetry lists ALL violations; a skip funnel records each skip in state without telemetry touching it', async ({
        request,
    }) => {
        const token = (await registerUserViaAPI(request)).access_token;

        // (a) BOTH an unknown event AND non-object properties → 400 whose body
        //     enumerates BOTH messages (probe-verified — validators do not
        //     short-circuit). Proves the allow-list message is the real enum.
        const both = await request.post(ONB.telemetry, {
            headers: authedHeaders(token),
            data: { event: 'nope_event', properties: 'not-an-object' },
        });
        expect(both.status()).toBe(400);
        const bothBody = JSON.stringify(await both.json());
        expect(bothBody).toContain('event must be one of the following values');
        expect(bothBody).toContain('onboarding_opened'); // enum is spelled out
        expect(bothBody).toContain('properties must be an object');

        // (b) Missing `event` entirely → still 400 on the event enum.
        const missing = await request.post(ONB.telemetry, {
            headers: authedHeaders(token),
            data: { properties: { a: 1 } },
        });
        expect(missing.status()).toBe(400);
        expect(JSON.stringify(await missing.json())).toContain(
            'event must be one of the following values',
        );

        // (c) A realistic SKIP funnel. For each skipped step we fire the
        //     allow-listed telemetry AND mirror the skip into `skippedSteps`
        //     via PATCH — exactly the pairing the wizard does (skip() emits
        //     telemetry then dispatches recordSkip). Telemetry is 204; the
        //     skippedSteps array grows monotonically and de-dupes on the
        //     client, so re-skipping the same id must not double it.
        const skipPlan: Array<{ stepKind: string; stepId: string }> = [
            { stepKind: 'ai-choice', stepId: 'ai-choice' },
            { stepKind: 'storage-choice', stepId: 'storage-choice' },
            { stepKind: 'plugins-catalog', stepId: 'plugins-catalog' },
        ];
        const skipped: string[] = [];
        for (const step of skipPlan) {
            const tel = await request.post(ONB.telemetry, {
                headers: authedHeaders(token),
                data: { event: 'onboarding_step_skipped', properties: step },
            });
            expect(tel.status(), `skip telemetry for ${step.stepId}`).toBe(204);
            expect((await tel.text()).length).toBe(0);

            if (!skipped.includes(step.stepId)) skipped.push(step.stepId);
            const r = await patchState(request, token, { skippedSteps: skipped });
            expect(r.state.skippedSteps).toEqual(skipped);
        }

        // Re-fire the SAME skip (telemetry 204) and re-PATCH the de-duped array
        // → no duplication, mirroring the client `recordSkip` "append once".
        const dupTel = await request.post(ONB.telemetry, {
            headers: authedHeaders(token),
            data: { event: 'onboarding_step_skipped', properties: skipPlan[0] },
        });
        expect(dupTel.status()).toBe(204);
        const afterDup = await patchState(request, token, { skippedSteps: skipped });
        expect(afterDup.state.skippedSteps).toEqual([
            'ai-choice',
            'storage-choice',
            'plugins-catalog',
        ]);

        // (d) Telemetry — including the two rejected calls above — NEVER mutated
        //     onboarding lifecycle state: still un-dismissed, un-completed.
        const finalState = await getState(request, token);
        expect(finalState.completedAt).toBeNull();
        expect(finalState.dismissedAt).toBeNull();
        expect(finalState.state.skippedSteps).toEqual([
            'ai-choice',
            'storage-choice',
            'plugins-catalog',
        ]);

        // (e) Telemetry requires auth (no bearer → 401), independent of body.
        const unauth = await request.post(ONB.telemetry, {
            data: { event: 'onboarding_opened' },
        });
        expect(unauth.status()).toBe(401);
    });
});

// ─── Flow 6: per-user isolation, concurrent last-write-wins, no cross-leak ───

test.describe('Onboarding deep — per-user isolation + concurrent last-write-wins', () => {
    test('two users keep independent state; racing patches resolve to one value; dismiss/complete never leak across users', async ({
        request,
    }) => {
        const userA = (await registerUserViaAPI(request)).access_token;
        const userB = (await registerUserViaAPI(request)).access_token;

        // Both start pristine + independent.
        const a0 = await getState(request, userA);
        const b0 = await getState(request, userB);
        expect(a0.state.lastStep).toBe(0);
        expect(b0.state.lastStep).toBe(0);

        // Diverge A from B: give A a full BYOK profile + progress.
        await patchState(request, userA, {
            ai: { choice: 'claude-code' },
            storage: { choice: 'user-github' },
            deploy: { choice: 'vercel' },
            lastStep: 5,
            skippedSteps: ['welcome'],
            pluginsReviewed: true,
        });

        // B must remain UTTERLY pristine — no leakage of A's choices.
        const bAfterA = await getState(request, userB);
        expect(bAfterA.state.ai.choice).toBe('ever-works');
        expect(bAfterA.state.storage.choice).toBe('ever-works-git');
        expect(bAfterA.state.deploy.choice).toBe('ever-works');
        expect(bAfterA.state.lastStep).toBe(0);
        expect(bAfterA.state.skippedSteps).toEqual([]);
        expect(bAfterA.state.pluginsReviewed).toBe(false);

        // Step lists diverge accordingly (A: 9-step full BYOK, B: 6-step base).
        expect(computeStepIds(bAfterA.state)).toHaveLength(6);

        // CONCURRENCY: fire two conflicting ai.choice patches for user A at
        // once. There is no optimistic-lock/409 (probe-verified) — last write
        // wins. Whichever lands last, the persisted value must be exactly ONE
        // of the two candidates, and all OTHER fields A set earlier survive.
        const candidates: AiChoice[] = ['gemini', 'grok'];
        await Promise.all(
            candidates.map((choice) =>
                request.patch(ONB.state, {
                    headers: authedHeaders(userA),
                    data: { state: { ai: { choice } } },
                }),
            ),
        );
        const aAfterRace = await getState(request, userA);
        expect(candidates).toContain(aAfterRace.state.ai.choice);
        // Deep-merge held under the race: A's earlier non-ai fields untouched.
        expect(aAfterRace.state.storage.choice).toBe('user-github');
        expect(aAfterRace.state.deploy.choice).toBe('vercel');
        expect(aAfterRace.state.lastStep).toBe(5);
        expect(aAfterRace.state.skippedSteps).toEqual(['welcome']);

        // Dismiss + complete user A → both timestamps set for A only.
        expect((await request.post(ONB.dismiss, { headers: authedHeaders(userA) })).status()).toBe(
            200,
        );
        expect((await request.post(ONB.complete, { headers: authedHeaders(userA) })).status()).toBe(
            200,
        );
        const aFinal = await getState(request, userA);
        expect(aFinal.dismissedAt).not.toBeNull();
        expect(aFinal.completedAt).not.toBeNull();

        // User B's lifecycle timestamps are STILL null — dismiss/complete are
        // strictly per-user. B can still auto-open; A cannot.
        const bFinal = await getState(request, userB);
        expect(bFinal.dismissedAt).toBeNull();
        expect(bFinal.completedAt).toBeNull();
        expect(shouldAutoOpen(bFinal, 0)).toBe(true);
        expect(shouldAutoOpen(aFinal, 0)).toBe(false);
    });
});
