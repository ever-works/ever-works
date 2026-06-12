import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-mission-budget-contract — the PER-MISSION BUDGET READ surface
 * (`GET /api/me/missions/:id/budget`, Phase 7 PR U) of the Ever Works Missions
 * taxonomy. Drives the real Missions controller
 * (`apps/api/src/missions/missions.controller.ts` → `budget()` →
 * `service.getForUser(userId, id)` ownership gate, then
 * `@ever-works/agent/budgets` `BudgetService.summarizeForOwner({ ownerType:
 * MISSION, ownerId })`).
 *
 * Every status code, message, and JSON shape asserted below was PROBED against
 * the LIVE API at http://127.0.0.1:3100 before being written (2026-06-12).
 *
 * NON-DUPLICATION — this file pins the per-Mission budget READ contract +
 * its owner scoping, deliberately staying clear of the two sibling specs:
 *   - `flow-mission-guardrails.spec.ts` pins the Mission `guardrailsOverride`
 *     policy envelope (REPLACE-not-merge PATCH, clone snapshot, lifecycle
 *     persistence) and the `outstandingIdeasCap` inheritance ladder — it never
 *     touches the `/budget` endpoint.
 *   - `flow-budget-agent-spend.spec.ts` pins the AGENT-scoped budget
 *     (`GET /api/agents/:id/budget`, a thinner shape with NO blocked/allowOverage/
 *     percentUsed), the `/api/me/usage/account-wide` summary, the per-run
 *     `maxBudgetCentsPerRun` guardrail on prefs, and the over-budget hard stop.
 *   This file pins the contracts neither covers:
 *     1. The exact `OwnerBudgetSummary` shape of a FRESH Mission's budget
 *        (ownerType='mission', ownerId=missionId, calendar-month window,
 *        currentSpendCents 0, capCents null, lowercase 'usd', percentUsed null,
 *        allowOverage true, blocked false) — the well-formed ZERO state, and the
 *        key set that distinguishes it from BOTH the account-wide summary (which
 *        carries `userId` not `ownerType/ownerId`) AND the per-Agent budget
 *        (which omits blocked/allowOverage/percentUsed).
 *     2. OWNER SCOPING of the read: anon→401, malformed id→400 (ParseUUIDPipe),
 *        unknown well-formed uuid→404 "Mission not found", and a STRANGER→the
 *        SAME opaque 404 (the ownership gate is `getForUser`, identical to the
 *        Mission-GET surface — no existence leak).
 *     3. The budget READ is INDEPENDENT of the account-wide cap: setting (or
 *        even 0-capping + overage-off, which BLOCKS the account-wide summary)
 *        the user's monthly cap never changes the per-Mission budget's capCents/
 *        blocked/allowOverage — they are different owner rows.
 *     4. The Mission `guardrailsOverride.maxBudgetCentsPerRun` (a gate-time
 *        per-run knob) does NOT become the budget rollup's `capCents` — the
 *        budget cap comes only from an AgentBudget row keyed (mission, id),
 *        which is not REST-creatable in v1 ⇒ capCents stays null.
 *     5. The budget read is available across the FULL Mission lifecycle
 *        (active/paused/completed) and ownerId always equals the path id; a
 *        cloned Mission gets its OWN budget bucket keyed on the clone's id.
 *     6. The Mission budget window is the SAME calendar-month UTC window as the
 *        account-wide summary (the per-owner and per-user rollups share one
 *        period engine) — distinct from the Agent rollup's rolling-30d window.
 *
 * PROBED CONTRACTS (live, 2026-06-12):
 *   GET /api/me/missions/:id/budget → 200 OwnerBudgetSummary:
 *     { ownerType:'mission', ownerId:<missionId>, periodStart(ISO 1st-of-month),
 *       periodEnd(ISO 1st-of-next-month), currentSpendCents:0, capCents:null,
 *       currency:'usd', percentUsed:null, allowOverage:true, blocked:false }.
 *   Anon → 401 {message:'Unauthorized'}; bad uuid → 400 "Validation failed
 *     (uuid is expected)" (ParseUUIDPipe); unknown uuid → 404 "Mission not
 *     found"; stranger → 404 "Mission not found" (same opaque gate).
 *   Setting account-wide cap (incl. 0 + overage-off ⇒ account summary blocked)
 *     leaves the Mission budget capCents null / blocked false / allowOverage true.
 *   guardrailsOverride.maxBudgetCentsPerRun does NOT surface as budget capCents.
 *   Budget readable on paused + completed Missions; ownerId == path id always.
 *   Mission budget periodStart/periodEnd == account-wide periodStart/periodEnd.
 *
 * Cross-spec isolation: every budget MUTATION (the account-wide cap toggles)
 * runs on a FRESH registerUserViaAPI() user so a cap set here never shadows a
 * sibling. The seeded user (a real persistent account) is touched ONLY for the
 * read-only owner-scoping flow. Unique stamps from a per-test counter; assert
 * shape / containment, never global counts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';
const MONTH_START_RE = /^\d{4}-\d{2}-01T00:00:00\.000Z$/;
const PREFS = `${API_BASE}/api/me/work-agent/preferences`;
const ACCOUNT_WIDE = `${API_BASE}/api/me/usage/account-wide`;

/** Exact key set of the per-Mission OwnerBudgetSummary (probed live). */
const OWNER_BUDGET_KEYS = [
    'allowOverage',
    'blocked',
    'capCents',
    'currency',
    'currentSpendCents',
    'ownerId',
    'ownerType',
    'percentUsed',
    'periodEnd',
    'periodStart',
] as const;

interface OwnerBudgetSummary {
    ownerType: string;
    ownerId: string;
    periodStart: string;
    periodEnd: string;
    currentSpendCents: number;
    capCents: number | null;
    currency: string;
    percentUsed: number | null;
    allowOverage: boolean;
    blocked: boolean;
}

interface MissionDto {
    id: string;
    title: string;
    status: 'active' | 'paused' | 'completed' | 'failed';
    guardrailsOverride: Record<string, unknown> | null;
    sourceMissionId: string | null;
}

interface CloneResult {
    mission: MissionDto;
}

/** Per-test monotonic stamp — built from the test title, NOT a module clock. */
function stamper(title: string): () => string {
    let n = 0;
    const base = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24);
    return () => `${base}-${n++}`;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
): Promise<MissionDto> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const m = (await res.json()) as MissionDto;
    expect(m.id).toMatch(UUID_RE);
    return m;
}

async function getBudget(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<OwnerBudgetSummary> {
    const res = await request.get(`${API_BASE}/api/me/missions/${missionId}/budget`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `budget GET body=${await res.text()}`).toBe(200);
    return res.json();
}

/** Assert a Mission budget is the well-formed, uncapped ZERO state for `id`. */
function expectZeroStateBudget(b: OwnerBudgetSummary, id: string): void {
    expect(b.ownerType).toBe('mission');
    expect(b.ownerId).toBe(id);
    expect(b.currentSpendCents).toBe(0);
    expect(b.capCents).toBeNull();
    expect(b.currency).toBe('usd');
    expect(b.percentUsed).toBeNull();
    expect(b.allowOverage).toBe(true);
    expect(b.blocked).toBe(false);
    expect(b.periodStart).toMatch(MONTH_START_RE);
    expect(b.periodEnd).toMatch(MONTH_START_RE);
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token as string;
}

test.describe('flow: per-Mission budget READ contract + owner scoping (GET /api/me/missions/:id/budget)', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 1 — THE FRESH-MISSION BUDGET SHAPE. A brand-new Mission's budget
    // is the well-formed ZERO state: ownerType='mission', ownerId=missionId,
    // calendar-month window, 0 spend, null cap, lowercase 'usd', null percent,
    // overage-open, not-blocked. The exact key set is the OwnerBudgetSummary
    // envelope — distinct from BOTH the account-wide summary and the per-Agent
    // budget.
    // ──────────────────────────────────────────────────────────────────
    test('a fresh Mission budget is the well-formed zero-state OwnerBudgetSummary with the exact documented key set', async ({
        request,
    }) => {
        const s = stamper('fresh-shape');
        const { access_token: token } = await registerUserViaAPI(request);
        const mission = await createMission(request, token, {
            title: `Budget shape ${s()}`,
            description:
                'A fresh mission whose budget read returns the documented zero-state shape',
            type: 'one-shot',
        });

        const budget = await getBudget(request, token, mission.id);
        expectZeroStateBudget(budget, mission.id);

        // The envelope carries EXACTLY the OwnerBudgetSummary keys — no more, no
        // fewer. This is what distinguishes it from the account-wide summary.
        expect(Object.keys(budget).sort()).toEqual([...OWNER_BUDGET_KEYS]);

        // Field TYPES are pinned (a regression to a digit-string cap or a numeric
        // currency would slip past a value-only check).
        expect(typeof budget.ownerType).toBe('string');
        expect(typeof budget.ownerId).toBe('string');
        expect(typeof budget.currentSpendCents).toBe('number');
        expect(typeof budget.currency).toBe('string');
        expect(typeof budget.allowOverage).toBe('boolean');
        expect(typeof budget.blocked).toBe('boolean');
        // capCents / percentUsed are null in the zero-state (no cap row).
        expect(budget.capCents).toBeNull();
        expect(budget.percentUsed).toBeNull();
    });

    test('the Mission budget key set differs from the account-wide summary (ownerType/ownerId vs userId) and from the Agent budget (richer)', async ({
        request,
    }) => {
        const s = stamper('shape-contrast');
        const { access_token: token } = await registerUserViaAPI(request);
        const mission = await createMission(request, token, {
            title: `Budget contrast ${s()}`,
            description:
                'A mission used to contrast the per-owner budget key set with the account summary',
            type: 'one-shot',
        });

        const missionBudget = await getBudget(request, token, mission.id);
        const accountRes = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) });
        expect(accountRes.status()).toBe(200);
        const account = (await accountRes.json()) as Record<string, unknown>;

        // The per-Mission summary is keyed by polymorphic owner (ownerType+ownerId);
        // the account-wide summary is keyed by userId. Neither carries the other's key.
        expect(missionBudget).toHaveProperty('ownerType');
        expect(missionBudget).toHaveProperty('ownerId');
        expect(missionBudget).not.toHaveProperty('userId');
        expect(account).toHaveProperty('userId');
        expect(account).not.toHaveProperty('ownerType');
        expect(account).not.toHaveProperty('ownerId');

        // Both, being the SAME UserBudgetSummary engine, share the gate fields —
        // the per-Mission summary is the RICHER per-owner shape (vs the thin Agent
        // budget that omits these three). Pin their presence here.
        for (const k of ['blocked', 'allowOverage', 'percentUsed', 'capCents', 'currency']) {
            expect(missionBudget, `mission budget carries ${k}`).toHaveProperty(k);
            expect(account, `account summary carries ${k}`).toHaveProperty(k);
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 2 — OWNER SCOPING OF THE READ. The budget read is gated exactly
    // like the Mission GET (it calls service.getForUser first): anon→401,
    // malformed id→400 (ParseUUIDPipe), unknown well-formed uuid→404, and a
    // STRANGER→the SAME opaque 404 "Mission not found" — the per-Mission spend
    // of one user is invisible to everyone else with no existence leak.
    // ──────────────────────────────────────────────────────────────────
    test('budget read closure modes: anon→401, malformed id→400, unknown uuid→404 "Mission not found"', async ({
        request,
    }) => {
        const s = stamper('closure');
        const { access_token: token } = await registerUserViaAPI(request);
        const mission = await createMission(request, token, {
            title: `Closure ${s()}`,
            description:
                'A mission used to assert the budget endpoints auth/validation closure modes',
            type: 'one-shot',
        });

        // Anonymous (no Authorization header) → 401 Unauthorized.
        const anon = await request.get(`${API_BASE}/api/me/missions/${mission.id}/budget`);
        expect(anon.status(), 'anon budget read → 401').toBe(401);
        expect((await anon.json()).message).toMatch(/unauthorized/i);

        // Malformed id is rejected by ParseUUIDPipe BEFORE the ownership gate → 400.
        const badId = await request.get(`${API_BASE}/api/me/missions/not-a-uuid/budget`, {
            headers: authedHeaders(token),
        });
        expect(badId.status(), 'malformed id → 400 (ParseUUIDPipe)').toBe(400);
        expect((await badId.json()).message).toMatch(/uuid is expected/i);

        // Well-formed but non-existent uuid → 404 "Mission not found".
        const unknown = await request.get(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/budget`, {
            headers: authedHeaders(token),
        });
        expect(unknown.status(), 'unknown uuid → 404').toBe(404);
        expect((await unknown.json()).message).toMatch(/mission not found/i);

        // Sanity: the owner CAN read their own (proves the 401/404s above are the
        // gate, not a broken endpoint).
        expectZeroStateBudget(await getBudget(request, token, mission.id), mission.id);
    });

    test('a stranger gets the SAME opaque 404 as a missing Mission — the budget read never leaks existence', async ({
        request,
    }) => {
        const s = stamper('stranger');
        const owner = await registerUserViaAPI(request);
        const mission = await createMission(request, owner.access_token, {
            title: `Private budget ${s()}`,
            description:
                'A mission whose per-mission spend a stranger must never be able to introspect',
            type: 'one-shot',
        });

        const stranger = await registerUserViaAPI(request);
        const sh = authedHeaders(stranger.access_token);

        // Stranger budget read → 404, with the SAME "Mission not found" body as an
        // unknown uuid (no "exists but forbidden" 403 that would leak existence).
        const strangerBudget = await request.get(
            `${API_BASE}/api/me/missions/${mission.id}/budget`,
            { headers: sh },
        );
        expect(strangerBudget.status(), 'stranger budget read → 404').toBe(404);
        expect((await strangerBudget.json()).message).toMatch(/mission not found/i);

        // The stranger's own unknown-uuid read returns the identical opaque body —
        // proving foreign-existing and truly-missing are indistinguishable.
        const strangerUnknown = await request.get(
            `${API_BASE}/api/me/missions/${UNKNOWN_UUID}/budget`,
            { headers: sh },
        );
        expect(strangerUnknown.status()).toBe(404);
        expect((await strangerUnknown.json()).message).toMatch(/mission not found/i);

        // The owner still reads it fine — the 404 is scoping, not corruption.
        expectZeroStateBudget(await getBudget(request, owner.access_token, mission.id), mission.id);
    });

    test('two users each owning a same-titled Mission read INDEPENDENT, self-scoped budgets (ownerId is each own mission id)', async ({
        request,
    }) => {
        const s = stamper('two-owners');
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const title = `Shared title ${s()}`;
        const desc =
            'Two distinct users own a same-titled mission; each budget is scoped to its own id';

        const mA = await createMission(request, a.access_token, {
            title,
            description: desc,
            type: 'one-shot',
        });
        const mB = await createMission(request, b.access_token, {
            title,
            description: desc,
            type: 'one-shot',
        });
        expect(mA.id).not.toBe(mB.id);

        const bA = await getBudget(request, a.access_token, mA.id);
        const bB = await getBudget(request, b.access_token, mB.id);
        // Each budget reports ITS OWN mission as the owner — no bleed across users.
        expect(bA.ownerId).toBe(mA.id);
        expect(bB.ownerId).toBe(mB.id);
        expect(bA.ownerId).not.toBe(bB.ownerId);

        // And each is blind to the other's mission budget (cross-read → 404).
        const aReadsB = await request.get(`${API_BASE}/api/me/missions/${mB.id}/budget`, {
            headers: authedHeaders(a.access_token),
        });
        expect(aReadsB.status()).toBe(404);
        const bReadsA = await request.get(`${API_BASE}/api/me/missions/${mA.id}/budget`, {
            headers: authedHeaders(b.access_token),
        });
        expect(bReadsA.status()).toBe(404);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 3 — THE PER-MISSION BUDGET IS ITS OWN SURFACE, INDEPENDENT OF THE
    // ACCOUNT-WIDE CAP. The Mission budget's capCents comes ONLY from a
    // per-(mission) AgentBudget row (not REST-creatable in v1), so setting the
    // user's monthly account-wide cap — even a 0-cap + overage-off that BLOCKS
    // the account-wide summary — never changes the per-Mission budget's
    // capCents/blocked/allowOverage. Different owner rows entirely.
    // ──────────────────────────────────────────────────────────────────
    test('setting the account-wide monthly cap does NOT change the per-Mission budget (different owner rows)', async ({
        request,
    }) => {
        const s = stamper('vs-account-cap');
        const { access_token: token } = await registerUserViaAPI(request);
        const mission = await createMission(request, token, {
            title: `Account cap iso ${s()}`,
            description:
                'A mission whose budget must stay uncapped even when the account-wide cap is set',
            type: 'one-shot',
        });

        // Baseline — uncapped zero-state.
        expectZeroStateBudget(await getBudget(request, token, mission.id), mission.id);

        // Arm a $50 account-wide monthly cap, overage off.
        const putCap = await request.put(PREFS, {
            headers: authedHeaders(token),
            data: { accountWideMonthlyCapCents: '5000', accountWideAllowOverage: false },
        });
        expect(putCap.status(), `put account cap body=${await putCap.text()}`).toBe(200);

        // The account-wide SUMMARY now reflects the cap (proving the cap really landed)…
        const account = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) });
        expect((await account.json()).capCents).toBe(5000);

        // …but the per-Mission budget is UNTOUCHED — capCents still null, gate open.
        const missionBudget = await getBudget(request, token, mission.id);
        expect(missionBudget.capCents, 'account cap does not become the mission cap').toBeNull();
        expect(missionBudget.allowOverage).toBe(true);
        expect(missionBudget.blocked).toBe(false);
        expectZeroStateBudget(missionBudget, mission.id);
    });

    test('a 0-cap + overage-off account that BLOCKS the account-wide summary leaves the per-Mission budget unblocked', async ({
        request,
    }) => {
        const s = stamper('account-blocked');
        const { access_token: token } = await registerUserViaAPI(request);
        const mission = await createMission(request, token, {
            title: `Hard stop iso ${s()}`,
            description:
                'A mission whose budget gate stays open even while the account-wide gate is blocked',
            type: 'one-shot',
        });

        // Drive the account-wide HARD STOP: cap 0 + overage off ⇒ spend(0) >= cap(0)
        // && !overage ⇒ the account summary is blocked.
        const put = await request.put(PREFS, {
            headers: authedHeaders(token),
            data: { accountWideMonthlyCapCents: '0', accountWideAllowOverage: false },
        });
        expect(put.status()).toBe(200);
        const account = (await (
            await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) })
        ).json()) as { capCents: number | null; blocked: boolean };
        expect(account.capCents, 'account cap is 0').toBe(0);
        expect(account.blocked, 'account-wide gate is BLOCKED').toBe(true);

        // The per-Mission budget does NOT inherit the account block — it has no cap
        // of its own, so it stays open. The two gates are decoupled by design.
        const missionBudget = await getBudget(request, token, mission.id);
        expect(missionBudget.capCents, 'mission budget has no cap of its own').toBeNull();
        expect(
            missionBudget.blocked,
            'mission budget is NOT blocked by the account hard stop',
        ).toBe(false);
        expect(missionBudget.allowOverage).toBe(true);
        expect(missionBudget.percentUsed).toBeNull();
    });

    test('the Mission guardrailsOverride.maxBudgetCentsPerRun does NOT surface as the budget capCents (gate-time knob ≠ rollup cap)', async ({
        request,
    }) => {
        const s = stamper('guardrail-vs-cap');
        const { access_token: token } = await registerUserViaAPI(request);

        // A mission carrying a per-run budget guardrail (the gate-time knob enforced
        // before a single agent run) — this is NOT the budget rollup's monthly cap.
        const mission = await createMission(request, token, {
            title: `Guardrail budget ${s()}`,
            description:
                'A mission with a per-run budget guardrail to prove it is not the rollup cap',
            type: 'one-shot',
            guardrailsOverride: { maxBudgetCentsPerRun: 5000, maxWorksPerRun: 3 },
        });
        expect(mission.guardrailsOverride).toMatchObject({ maxBudgetCentsPerRun: 5000 });

        // The budget rollup's capCents comes ONLY from a per-(mission) AgentBudget
        // row (not REST-creatable in v1), so the guardrail's 5000 never appears here.
        const budget = await getBudget(request, token, mission.id);
        expect(budget.capCents, 'per-run guardrail is not the rollup cap').toBeNull();
        expectZeroStateBudget(budget, mission.id);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 4 — LIFECYCLE + CLONE + PERIOD WINDOW. The budget read is available
    // across the full Mission lifecycle (active/paused/completed) and is NOT
    // gated by Mission status; ownerId always equals the path id; a cloned
    // Mission gets its OWN budget bucket keyed on the clone's id; and the
    // Mission budget window is the SAME calendar-month UTC window as the
    // account-wide summary (one period engine for both per-owner + per-user).
    // ──────────────────────────────────────────────────────────────────
    test('the budget read is available across the full lifecycle: active → paused → completed (status never gates it)', async ({
        request,
    }) => {
        const s = stamper('lifecycle');
        const { access_token: token } = await registerUserViaAPI(request);
        const mission = await createMission(request, token, {
            title: `Lifecycle budget ${s()}`,
            description: 'A mission whose budget read must work in every lifecycle state',
            type: 'one-shot',
        });

        // ACTIVE (create default) — readable.
        expect(mission.status).toBe('active');
        expectZeroStateBudget(await getBudget(request, token, mission.id), mission.id);

        // PAUSED — still readable, same zero-state.
        const paused = await request.post(`${API_BASE}/api/me/missions/${mission.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(paused.status()).toBe(200);
        expect(((await paused.json()) as MissionDto).status).toBe('paused');
        expectZeroStateBudget(await getBudget(request, token, mission.id), mission.id);

        // COMPLETED (resume → complete) — the budget read survives archival; the
        // spend history is part of the Mission's record even after completion.
        await request.post(`${API_BASE}/api/me/missions/${mission.id}/resume`, {
            headers: authedHeaders(token),
        });
        const completed = await request.post(`${API_BASE}/api/me/missions/${mission.id}/complete`, {
            headers: authedHeaders(token),
        });
        expect(completed.status()).toBe(200);
        expect(((await completed.json()) as MissionDto).status).toBe('completed');
        expectZeroStateBudget(await getBudget(request, token, mission.id), mission.id);
    });

    test('a cloned Mission gets its OWN budget bucket keyed on the clone id (not the source id)', async ({
        request,
    }) => {
        const s = stamper('clone-bucket');
        const { access_token: token } = await registerUserViaAPI(request);
        const source = await createMission(request, token, {
            title: `Clone src ${s()}`,
            description:
                'A source mission whose clone must own a separate, self-keyed budget bucket',
            type: 'one-shot',
            guardrailsOverride: { maxBudgetCentsPerRun: 1234 },
        });

        const cloneRes = await request.post(`${API_BASE}/api/me/missions/${source.id}/clone`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(cloneRes.status(), `clone body=${await cloneRes.text()}`).toBe(201);
        const clone = (await cloneRes.json()) as CloneResult;
        expect(clone.mission.sourceMissionId).toBe(source.id);
        expect(clone.mission.id).not.toBe(source.id);

        // Each budget is keyed on its OWN mission id — the clone's budget ownerId is
        // the clone's id, the source's is the source's. The snapshot of the per-run
        // guardrail rode through (it's a policy field), but it is NOT the rollup cap:
        // both budgets are the uncapped zero-state, each self-owned.
        const sourceBudget = await getBudget(request, token, source.id);
        const cloneBudget = await getBudget(request, token, clone.mission.id);
        expect(sourceBudget.ownerId).toBe(source.id);
        expect(cloneBudget.ownerId).toBe(clone.mission.id);
        expect(cloneBudget.ownerId).not.toBe(sourceBudget.ownerId);
        expectZeroStateBudget(sourceBudget, source.id);
        expectZeroStateBudget(cloneBudget, clone.mission.id);
    });

    test('the per-Mission budget window is the SAME calendar-month UTC window as the account-wide summary (one period engine)', async ({
        request,
    }) => {
        const s = stamper('period-window');
        const { access_token: token } = await registerUserViaAPI(request);
        const mission = await createMission(request, token, {
            title: `Window ${s()}`,
            description:
                'A mission whose budget window must align with the account-wide calendar-month window',
            type: 'one-shot',
        });

        const missionBudget = await getBudget(request, token, mission.id);
        const account = (await (
            await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) })
        ).json()) as { periodStart: string; periodEnd: string; currency: string };

        // Both boundaries are clean first-of-month UTC midnights.
        expect(missionBudget.periodStart).toMatch(MONTH_START_RE);
        expect(missionBudget.periodEnd).toMatch(MONTH_START_RE);

        // The per-owner and per-user rollups share ONE period engine — identical
        // window boundaries (NOT the Agent rollup's rolling-30d window).
        expect(missionBudget.periodStart, 'mission start == account start').toBe(
            account.periodStart,
        );
        expect(missionBudget.periodEnd, 'mission end == account end').toBe(account.periodEnd);

        // The window is exactly one calendar month forward (28..31 days).
        const spanDays =
            (Date.parse(missionBudget.periodEnd) - Date.parse(missionBudget.periodStart)) /
            (24 * 60 * 60 * 1000);
        expect(spanDays).toBeGreaterThanOrEqual(28);
        expect(spanDays).toBeLessThanOrEqual(31);

        // Both report lowercase 'usd' (the per-owner/per-user UserBudgetSummary
        // casing — distinct from the per-Agent rollup's UPPER-CASE 'USD').
        expect(missionBudget.currency).toBe('usd');
        expect(account.currency).toBe('usd');
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 5 — OWNER-SCOPING AGAINST A REAL PERSISTENT ACCOUNT. The seeded
    // user (a durable account, not a throwaway) owns a Mission; a fresh
    // stranger can neither read its budget nor enumerate it. This read-only
    // flow never mutates the seeded user's caps (cross-spec safety).
    // ──────────────────────────────────────────────────────────────────
    test('owner-scoping holds against the seeded (persistent) account: stranger 404, owner reads the zero-state', async ({
        request,
    }) => {
        const s = stamper('seeded-owner');
        const ownerToken = await seededToken(request);
        const mission = await createMission(request, ownerToken, {
            title: `Seeded budget ${s()}`,
            description:
                'A seeded-user mission whose budget a fresh stranger must not be able to read',
            type: 'one-shot',
        });

        // The seeded owner reads the well-formed zero-state for their own mission.
        expectZeroStateBudget(await getBudget(request, ownerToken, mission.id), mission.id);

        // A brand-new stranger is blocked with the opaque 404.
        const stranger = await registerUserViaAPI(request);
        const strangerBudget = await request.get(
            `${API_BASE}/api/me/missions/${mission.id}/budget`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(
            strangerBudget.status(),
            'stranger cannot read seeded-user mission budget → 404',
        ).toBe(404);
        expect((await strangerBudget.json()).message).toMatch(/mission not found/i);

        // Re-reading as the owner is unchanged — the stranger's probe was inert.
        expectZeroStateBudget(await getBudget(request, ownerToken, mission.id), mission.id);
    });
});
