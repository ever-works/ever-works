import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-org-billing-scope.spec.ts
 *
 * THEME: organization-scoped billing surface vs PERSONAL scope — subscription
 * plan, account-wide usage/spend, and budget caps in an ORG context, member
 * usage attribution, per-member (not per-org) plan transition, and cross-tenant
 * billing isolation.
 *
 * This is a DELIBERATELY DEGRADING suite. The big finding — verified live on the
 * sqlite/in-memory CI driver (http://127.0.0.1:3100) AND from the controller
 * source — is that THERE IS NO ORG-SCOPED BILLING SCOPE in this build:
 *
 *   • SUBSCRIPTION PLAN is USER-scoped. SubscriptionsController
 *     (@Controller('api/subscriptions'), AuthSessionGuard) resolves the plan via
 *     authService.getUser(auth.userId) → SubscriptionService.summarizePlan(user)
 *     / .assignPlanToUser(user, code). The endpoint takes NO org/tenant input and
 *     the active-org `X-Scope-Slug` header is IGNORED.
 *       GET  /api/subscriptions/plan
 *         → 200 { status:'success', enabled:true,
 *                 plan:{ code:'free', name:'Free', allowedCadences:[{cadence,allowed,payPerUse,reason?}] } }
 *         IDENTICAL with or without an X-Scope-Slug:<org> header.
 *       POST /api/subscriptions/plan { planCode:'free'|'standard'|'premium' }  (DTO field `planCode`, IsEnum)
 *         → 200 { plan:{ code, name, allowedCadences } } ; REAL DB mutation; follows the BEARER.
 *         → 400 unknown enum value ; → 401 no auth.
 *
 *   • ACCOUNT-WIDE USAGE is per-USER. AccountUsageController
 *     (@Controller('api/me/usage')) → BudgetService.summarizeForUser →
 *     PluginUsageRepository.getTotalSpendCentsForUser (WHERE e.userId = :userId).
 *       GET /api/me/usage/account-wide
 *         → 200 { userId, periodStart, periodEnd, currentSpendCents:number, capCents:number|null,
 *                 currency, percentUsed:number|null, allowOverage:boolean, blocked:boolean }
 *         IDENTICAL across org contexts (org-invariant). Contract:
 *           blocked     === (capCents !== null && currentSpendCents >= capCents && !allowOverage)
 *           percentUsed === (capCents>0 ? spend/cap*100 : null)   // null when capCents 0 or null
 *       The cap is a USER pref set via
 *         PUT /api/me/work-agent/preferences { accountWideMonthlyCapCents:'<digits>'|null, accountWideAllowOverage:boolean }
 *         → 200 (prefs echoed; cap is a BIGINT serialized as a digit STRING) ; → 400 non-numeric.
 *
 *   • BUDGETS are OWNER-scoped (BudgetOwnerType = work|idea|mission|agent — there
 *     is NO `organization`/`tenant` owner). BudgetsController is mounted ONLY at
 *     `api/works/:workId/budgets`; there is NO `api/organizations/:id/budgets`
 *     (nor org subscription/usage) route — they 4xx.
 *       POST /api/works/:id/budgets { scope:'global', monthlyCapCents } → 201
 *            { budget:{ id, workId, scope:'global', pluginId:null, monthlyCapCents,
 *                       currency:'usd', allowOverage, ownerType:'work', ownerId:null, ... } }
 *       GET  /api/works/:id/usage/summary → 200 { workId, totalSpendCents:0, perPlugin:[], globalBudget:{...}|null, ... }
 *     A Work created UNDER an org scope (X-Scope-Slug on POST /api/works) keeps the
 *     SAME per-Work surface keyed by workId — org stamping is invisible to billing.
 *     CROSS-TENANT: a non-owner reading/writing another user's Work budgets/usage → 403;
 *     unknown workId for the OWNER → 404.
 *
 *   • ORGANIZATIONS (@Controller('api/organizations')):
 *       POST /api/organizations { name } → 201 { id, tenantId, slug, displayName, registrationStatus:'draft', linkedWorkId:null }
 *       POST /api/organizations/register-company { name, countryCode } → 201
 *            { ..., registrationProvider:'manual', registrationStatus:'registered', linkedWorkId:<work uuid> }
 *       GET  /api/organizations/:slug → 200 for ANY authed user (GLOBAL resolver — metadata, not billing).
 *       A WRITE under a spoofed X-Scope-Slug of an org you don't belong to → 403.
 *
 * Every flow establishes the verified personal-scope baseline, probes the
 * org-scope variant, and asserts the strongest TRUE statement — never a fictional
 * org-billing contract. The degradation is recorded via test.info() annotations.
 *
 * Distinct from sibling specs (flow-subscriptions-budgets, subscriptions*,
 * budgets, usage-quota, account-usage, team-billing) which exercise the PERSONAL
 * / per-Work axis — the NEW axis here is the personal-vs-org SCOPE boundary,
 * per-member attribution, and cross-tenant billing isolation.
 *
 * GOTCHAS honoured: login DTO is {email,password} only; FRESH registerUserViaAPI
 * users for every plan/pref MUTATION (never the shared seeded user — a user-scoped
 * fake key would shadow the env key and break sibling chat specs); unique names
 * via Date.now+random; tolerate pre-existing rows (toContain, never exact counts);
 * org /{slug} resolver is global (200 any authed user); usage is always zero in CI.
 */

const PLAN_CODES = ['free', 'standard', 'premium'] as const;

interface PlanResponse {
    status: string;
    enabled: boolean;
    plan: {
        code: string;
        name: string;
        allowedCadences?: Array<{
            cadence: string;
            allowed: boolean;
            payPerUse: boolean;
            reason?: string;
        }>;
    };
}

interface AccountWideSummary {
    userId: string;
    periodStart: string;
    periodEnd: string;
    currentSpendCents: number;
    capCents: number | null;
    currency: string;
    percentUsed: number | null;
    allowOverage: boolean;
    blocked: boolean;
}

const uniq = (p: string) =>
    `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function scopedHeaders(token: string, scopeSlug?: string): Record<string, string> {
    const headers: Record<string, string> = { ...authedHeaders(token) };
    if (scopeSlug) headers['X-Scope-Slug'] = scopeSlug;
    return headers;
}

async function getPlan(
    request: APIRequestContext,
    token: string,
    scopeSlug?: string,
): Promise<PlanResponse> {
    const res = await request.get(`${API_BASE}/api/subscriptions/plan`, {
        headers: scopedHeaders(token, scopeSlug),
    });
    expect(res.status(), `GET plan status was ${res.status()}`).toBe(200);
    return (await res.json()) as PlanResponse;
}

async function setPlan(
    request: APIRequestContext,
    token: string,
    planCode: string,
    scopeSlug?: string,
) {
    return request.post(`${API_BASE}/api/subscriptions/plan`, {
        headers: scopedHeaders(token, scopeSlug),
        data: { planCode },
    });
}

async function accountWide(
    request: APIRequestContext,
    token: string,
    scopeSlug?: string,
): Promise<AccountWideSummary> {
    const res = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
        headers: scopedHeaders(token, scopeSlug),
    });
    expect(res.status(), `account-wide status was ${res.status()}`).toBe(200);
    return (await res.json()) as AccountWideSummary;
}

async function setAccountCap(
    request: APIRequestContext,
    token: string,
    capCents: string | null,
    allowOverage: boolean,
) {
    return request.put(`${API_BASE}/api/me/work-agent/preferences`, {
        headers: authedHeaders(token),
        data: { accountWideMonthlyCapCents: capCents, accountWideAllowOverage: allowOverage },
    });
}

async function createOrg(request: APIRequestContext, token: string, name: string) {
    const res = await request.post(`${API_BASE}/api/organizations`, {
        headers: authedHeaders(token),
        data: { name },
    });
    expect(res.status(), `create org body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json() as Promise<{
        id: string;
        tenantId: string;
        slug: string;
        displayName: string;
        linkedWorkId: string | null;
    }>;
}

/** Create a Work, optionally stamped under an org scope via the X-Scope-Slug header. */
async function createWorkInScope(
    request: APIRequestContext,
    token: string,
    name: string,
    scopeSlug?: string,
): Promise<string> {
    const headers: Record<string, string> = {
        ...scopedHeaders(token, scopeSlug),
        'content-type': 'application/json',
    };
    const slug = uniq(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    const res = await request.post(`${API_BASE}/api/works`, {
        headers,
        data: { name, slug, description: `e2e ${name}`, organization: false },
    });
    expect(res.status(), `create work body=${await res.text().catch(() => '')}`).toBeLessThan(300);
    const json = await res.json();
    const id = json?.work?.id ?? json?.id ?? '';
    expect(id, 'created work id').toBeTruthy();
    return id as string;
}

test.describe('Flow: org-scoped billing vs personal scope', () => {
    test('flow 1: subscription plan is USER-scoped & org-invariant — the same bearer reports/mutates the same plan WITH or WITHOUT an X-Scope-Slug org context', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const org = await createOrg(request, user.access_token, uniq('PlanScopeOrg'));

        // 1. Personal scope: a fresh user is on FREE.
        const personal0 = await getPlan(request, user.access_token);
        expect(personal0.plan.code).toBe('free');
        expect(personal0.enabled).toBe(true);

        // 2. The SAME plan read under the org's X-Scope-Slug is the same shape and
        //    tier — the subscription endpoint has no org dimension.
        const scoped0 = await getPlan(request, user.access_token, org.slug);
        expect(scoped0.plan.code).toBe('free');
        expect(scoped0.enabled).toBe(personal0.enabled);
        expect(scoped0.plan.allowedCadences?.length ?? 0).toBe(
            personal0.plan.allowedCadences?.length ?? 0,
        );

        // 3. Upgrade WHILE sending the org scope header. If a per-org plan existed
        //    this would mutate an "org plan"; it mutates the USER plan (the bearer).
        expect((await setPlan(request, user.access_token, 'premium', org.slug)).status()).toBe(200);

        // 4. The upgrade is visible from BOTH the personal AND the org-scoped read —
        //    proving a single user-scoped plan, not a per-scope plan.
        expect((await getPlan(request, user.access_token)).plan.code).toBe('premium');
        expect((await getPlan(request, user.access_token, org.slug)).plan.code).toBe('premium');

        // 5. Revert under personal scope; the org-scoped read tracks it too.
        expect((await setPlan(request, user.access_token, 'free')).status()).toBe(200);
        expect((await getPlan(request, user.access_token, org.slug)).plan.code).toBe('free');

        test.info().annotations.push({
            type: 'org-billing-scope',
            description:
                'No org-scoped subscription plan; X-Scope-Slug is ignored by /api/subscriptions/plan. Asserted the real user-scoped, org-invariant contract.',
        });
    });

    test('flow 2: account-wide usage rollup is per-USER & org-invariant — setting an account cap and switching the org context never changes the spend/cap/blocked arithmetic', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const orgA = await createOrg(request, user.access_token, uniq('UsageOrgA'));
        const orgB = await createOrg(request, user.access_token, uniq('UsageOrgB'));

        // 1. Zero-state account-wide summary, no cap.
        const base = await accountWide(request, user.access_token);
        expect(base.currentSpendCents).toBe(0);
        expect(base.capCents).toBeNull();
        expect(base.percentUsed).toBeNull();
        expect(base.blocked).toBe(false);

        // 2. Reading it under orgA vs orgB vs no-scope is identical: same userId,
        //    same zero spend. The org context is invisible to the rollup.
        const underA = await accountWide(request, user.access_token, orgA.slug);
        const underB = await accountWide(request, user.access_token, orgB.slug);
        expect(underA.userId).toBe(base.userId);
        expect(underB.userId).toBe(base.userId);
        expect(underA.currentSpendCents).toBe(0);
        expect(underB.currentSpendCents).toBe(0);

        // 3. Set a HARD account cap (no overage). Cap is a user pref, not an org pref —
        //    verify it lands and the arithmetic follows the documented contract:
        //    capCents 0, spend 0 >= 0, allowOverage false → blocked true; percentUsed null.
        expect((await setAccountCap(request, user.access_token, '0', false)).status()).toBe(200);
        const hardZeroCap = await accountWide(request, user.access_token, orgA.slug);
        expect(hardZeroCap.capCents).toBe(0);
        expect(hardZeroCap.percentUsed).toBeNull();
        expect(hardZeroCap.blocked).toBe(true);
        expect(hardZeroCap.allowOverage).toBe(false);

        // 4. Raise the cap above zero spend, soft overage → NOT blocked, percentUsed 0.
        expect((await setAccountCap(request, user.access_token, '100000', true)).status()).toBe(
            200,
        );
        const softCap = await accountWide(request, user.access_token, orgB.slug);
        expect(softCap.capCents).toBe(100000);
        expect(softCap.percentUsed).toBe(0);
        expect(softCap.blocked).toBe(false);
        expect(softCap.allowOverage).toBe(true);

        // 5. The cap arithmetic is identical no matter which org we claim to be in.
        const softNoScope = await accountWide(request, user.access_token);
        expect(softNoScope.capCents).toBe(softCap.capCents);
        expect(softNoScope.blocked).toBe(softCap.blocked);
        expect(softNoScope.percentUsed).toBe(softCap.percentUsed);

        // 6. Non-numeric cap is rejected (the pref is a bigint digit-string).
        const badCap = await request.put(`${API_BASE}/api/me/work-agent/preferences`, {
            headers: authedHeaders(user.access_token),
            data: { accountWideMonthlyCapCents: 'not-a-number' },
        });
        expect(badCap.status()).toBe(400);

        test.info().annotations.push({
            type: 'org-billing-scope',
            description:
                'No org-level usage cap; the account-wide cap is a USER pref keyed by userId. Verified org-invariant rollup + the blocked/percentUsed contract.',
        });
    });

    test('flow 3: a Work created UNDER an org scope still carries the SAME per-Work budget surface (the only real "billing scope") — and there is NO org-level budget/usage endpoint', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const org = await createOrg(request, user.access_token, uniq('BudgetOrg'));

        // 1. Create a Work stamped under the org scope.
        const workId = await createWorkInScope(
            request,
            user.access_token,
            'OrgScopedWork',
            org.slug,
        );

        // 2. The per-Work budget surface exists and is empty (org stamping is
        //    invisible to budgets — they key on workId, owner='work').
        const list0 = await request.get(`${API_BASE}/api/works/${workId}/budgets`, {
            headers: authedHeaders(user.access_token),
        });
        expect(list0.status()).toBe(200);
        expect((await list0.json()).budgets).toEqual([]);

        // 3. Set a GLOBAL cap on the org-scoped Work — succeeds with owner='work'.
        const create = await request.post(`${API_BASE}/api/works/${workId}/budgets`, {
            headers: authedHeaders(user.access_token),
            data: { scope: 'global', monthlyCapCents: 50000, allowOverage: false, currency: 'usd' },
        });
        expect(create.status()).toBe(201);
        const budget = (await create.json()).budget;
        expect(budget.scope).toBe('global');
        expect(budget.ownerType).toBe('work'); // NOT 'organization' — no such owner exists
        expect(budget.monthlyCapCents).toBe(50000);

        // 4. The cap is reflected in the per-Work usage summary's globalBudget block.
        const summary = await request.get(`${API_BASE}/api/works/${workId}/usage/summary`, {
            headers: authedHeaders(user.access_token),
        });
        expect(summary.status()).toBe(200);
        const sum = await summary.json();
        expect(sum.workId).toBe(workId);
        expect(sum.totalSpendCents).toBe(0);
        expect(sum.globalBudget?.monthlyCapCents).toBe(50000);
        expect(sum.globalBudget?.percentUsed).toBe(0); // 0 spend of a positive cap

        // 5. Confirm the org-LEVEL budget/usage routes simply do not exist — probe → 4xx.
        for (const path of [
            `/api/organizations/${org.id}/budgets`,
            `/api/organizations/${org.slug}/budgets`,
            `/api/organizations/${org.id}/usage`,
            `/api/organizations/${org.id}/usage/summary`,
        ]) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(res.status(), `${path} must not 5xx`).toBeLessThan(500);
            expect(
                [400, 401, 403, 404].includes(res.status()),
                `${path} should be a 4xx (no org-level billing route), got ${res.status()}`,
            ).toBe(true);
        }

        test.info().annotations.push({
            type: 'org-billing-scope',
            description:
                'Budgets are owner-scoped (work|idea|mission|agent) — no organization owner. Org-scoped Works fall back to the per-Work cap; org-level budget/usage endpoints are absent (4xx).',
        });
    });

    test("flow 4: MEMBER usage attribution — usage rolls up by the ACTING userId, so two users in/around the same tenant each see only their OWN attributed spend (never each other's)", async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);

        // alice owns an org + a billable Work inside it.
        const org = await createOrg(request, alice.access_token, uniq('AttribOrg'));
        const aliceWork = await createWorkInScope(
            request,
            alice.access_token,
            'AliceBillable',
            org.slug,
        );

        // 1. Each user's account-wide rollup is keyed by THEIR userId.
        const aliceUsage = await accountWide(request, alice.access_token);
        const bobUsage = await accountWide(request, bob.access_token);
        expect(aliceUsage.userId).not.toBe(bobUsage.userId);
        expect(aliceUsage.userId).toBe(alice.user.id);
        expect(bobUsage.userId).toBe(bob.user.id);

        // 2. Both are zero in CI (no billed plugin calls); the KEY point is attribution
        //    isolation: bob's rollup never reflects alice's Work.
        expect(aliceUsage.currentSpendCents).toBe(0);
        expect(bobUsage.currentSpendCents).toBe(0);

        // 3. bob (a different tenant) cannot even READ the per-Work usage/budgets of
        //    alice's Work — owner-scoped 403 (not a cross-tenant data leak). This is
        //    the attribution boundary made concrete.
        for (const path of [
            `/api/works/${aliceWork}/budgets`,
            `/api/works/${aliceWork}/usage/summary`,
            `/api/works/${aliceWork}/usage/trend`,
        ]) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(bob.access_token),
            });
            expect(res.status(), `bob reading alice's ${path}`).toBe(403);
        }

        // 4. bob cannot WRITE a budget on alice's Work either (assertWriteAccess → 403).
        const bobWrite = await request.post(`${API_BASE}/api/works/${aliceWork}/budgets`, {
            headers: authedHeaders(bob.access_token),
            data: { scope: 'global', monthlyCapCents: 1000 },
        });
        expect(bobWrite.status()).toBe(403);

        // 5. The org slug resolver IS global (any authed user resolves it) — but that
        //    grants NO billing visibility. bob resolves the org yet sees none of its spend.
        const bobResolvesOrg = await request.get(`${API_BASE}/api/organizations/${org.slug}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bobResolvesOrg.status()).toBe(200); // global resolver
        expect((await accountWide(request, bob.access_token)).currentSpendCents).toBe(0); // still none of alice's spend

        test.info().annotations.push({
            type: 'org-billing-scope',
            description:
                'Usage attribution is per-userId (PluginUsageEvents.userId). No org-aggregated usage view; the org slug resolver is global but conveys no cross-user billing visibility.',
        });
    });

    test('flow 5: org PLAN transition is per-MEMBER, not per-org — the org OWNER acts in the org scope while a NON-member is forbidden from claiming it, and each holds an INDEPENDENT subscription tier', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const peer = await registerUserViaAPI(request);
        const org = await createOrg(request, owner.access_token, uniq('PlanTenantOrg'));

        // Both users can RESOLVE the org slug — GET /api/organizations/:slug is a GLOBAL
        // metadata resolver (200 for any authed user). But resolving the slug grants NO
        // right to ACT in that org's scope.
        for (const u of [owner, peer]) {
            const r = await request.get(`${API_BASE}/api/organizations/${org.slug}`, {
                headers: authedHeaders(u.access_token),
            });
            expect(r.status()).toBe(200);
        }

        // VERIFIED LIVE: an X-Scope-Slug pointing at an org you don't own is rejected by
        // ScopeOwnershipGuard (scope-ownership.guard.ts) with 403 BEFORE the controller
        // runs — there is no shared/per-org plan a non-member could read or mutate. So the
        // per-member story is: the OWNER acts in the org scope (it just follows their
        // bearer); the NON-member is FORBIDDEN from that scope entirely.

        // 1. Owner starts on FREE — read under the org scope (owner's tenant === org tenant → 200).
        expect((await getPlan(request, owner.access_token, org.slug)).plan.code).toBe('free');

        // 2. Peer (a non-member) CANNOT claim the owner's org context at all: the
        //    subscription route is scope-guarded and 403s. This is the strongest TRUE
        //    statement that there is no per-org plan surface shared across members.
        const peerScoped = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: scopedHeaders(peer.access_token, org.slug),
        });
        expect(peerScoped.status(), 'non-member claiming owner org scope must be forbidden').toBe(
            403,
        );

        // 3. Owner upgrades to PREMIUM under the org scope. The mutation follows the
        //    OWNER's bearer (assignPlanToUser is per-user) — not an "org plan".
        expect((await setPlan(request, owner.access_token, 'premium', org.slug)).status()).toBe(
            200,
        );
        // Visible from BOTH the owner's org-scoped AND personal read — one user-scoped plan.
        expect((await getPlan(request, owner.access_token, org.slug)).plan.code).toBe('premium');
        expect((await getPlan(request, owner.access_token)).plan.code).toBe('premium');

        // 4. The peer's OWN plan is fully independent. Peer can only act in its OWN
        //    (personal / no-scope) context — upgrade to STANDARD there; owner stays premium.
        expect((await setPlan(request, peer.access_token, 'standard')).status()).toBe(200);
        expect((await getPlan(request, peer.access_token)).plan.code).toBe('standard');
        expect((await getPlan(request, owner.access_token, org.slug)).plan.code).toBe('premium');

        // 5. Cadence-gating arrays are well-formed per member (same cardinality across tiers).
        const ownerCadences =
            (await getPlan(request, owner.access_token, org.slug)).plan.allowedCadences ?? [];
        const peerCadences = (await getPlan(request, peer.access_token)).plan.allowedCadences ?? [];
        expect(ownerCadences.length).toBeGreaterThan(0);
        expect(peerCadences.length).toBe(ownerCadences.length);

        // Reset both to free to keep the shared DB tidy for sibling subscription specs.
        await setPlan(request, owner.access_token, 'free', org.slug);
        await setPlan(request, peer.access_token, 'free');
        expect((await getPlan(request, owner.access_token)).plan.code).toBe('free');
        expect((await getPlan(request, peer.access_token)).plan.code).toBe('free');

        test.info().annotations.push({
            type: 'org-billing-scope',
            description:
                'No org-level plan: assignPlanToUser is per-user. The org OWNER acts in the org scope (it follows their bearer) while ScopeOwnershipGuard 403s a non-member who claims the same X-Scope-Slug. Members/non-members hold fully independent tiers; the org context never aggregates billing.',
        });
    });

    test('flow 6: a REGISTERED company org links a billable "company" Work whose budget/usage is still owner-scoped + cross-tenant isolated; plan/usage stay user-scoped end-to-end', async ({
        request,
    }) => {
        const founder = await registerUserViaAPI(request);
        const outsider = await registerUserViaAPI(request);

        // 1. register-company mints a REGISTERED org WITH a linked company Work.
        const reg = await request.post(`${API_BASE}/api/organizations/register-company`, {
            headers: authedHeaders(founder.access_token),
            data: { name: uniq('RegCo'), countryCode: 'US' },
        });
        expect(reg.status()).toBe(201);
        const company = await reg.json();
        expect(company.registrationStatus).toBe('registered');
        expect(company.registrationProvider).toBe('manual');
        const linkedWorkId: string = company.linkedWorkId;
        expect(linkedWorkId, 'register-company should link a Work').toBeTruthy();

        // 2. The linked company Work has the SAME per-Work billing surface as any Work.
        const create = await request.post(`${API_BASE}/api/works/${linkedWorkId}/budgets`, {
            headers: authedHeaders(founder.access_token),
            data: { scope: 'global', monthlyCapCents: 250000, allowOverage: true, currency: 'usd' },
        });
        // The founder owns the linked work → 201. Branch defensively if membership is
        // modelled differently in some build (→ 403) so the flow stays truthful.
        expect([201, 403]).toContain(create.status());
        if (create.status() === 201) {
            const budget = (await create.json()).budget;
            expect(budget.ownerType).toBe('work');
            expect(budget.monthlyCapCents).toBe(250000);

            const summary = await request.get(
                `${API_BASE}/api/works/${linkedWorkId}/usage/summary`,
                {
                    headers: authedHeaders(founder.access_token),
                },
            );
            expect(summary.status()).toBe(200);
            const sum = await summary.json();
            expect(sum.totalSpendCents).toBe(0);
            expect(sum.globalBudget?.monthlyCapCents).toBe(250000);
        } else {
            test.info().annotations.push({
                type: 'note',
                description:
                    'Founder is not the linked-work owner in this build; budget write 403 — surface still owner-scoped.',
            });
        }

        // 3. An OUTSIDER (different tenant) cannot read the company Work's budgets —
        //    owner-scoped 403, even though register-company is "public-ish".
        const outsiderBudgets = await request.get(`${API_BASE}/api/works/${linkedWorkId}/budgets`, {
            headers: authedHeaders(outsider.access_token),
        });
        expect(outsiderBudgets.status()).toBe(403);

        // 4. The outsider CAN resolve the company org by slug (global resolver) but gets
        //    no billing visibility from it.
        const resolve = await request.get(`${API_BASE}/api/organizations/${company.slug}`, {
            headers: authedHeaders(outsider.access_token),
        });
        expect(resolve.status()).toBe(200);

        // 5. The founder's PLAN + account-wide usage remain user-scoped: querying them
        //    under the company org slug yields the same user-keyed result.
        const planUnderCompany = await getPlan(request, founder.access_token, company.slug);
        expect(PLAN_CODES).toContain(planUnderCompany.plan.code as (typeof PLAN_CODES)[number]);
        const usageUnderCompany = await accountWide(request, founder.access_token, company.slug);
        expect(usageUnderCompany.userId).toBe(founder.user.id);
        expect(usageUnderCompany.currentSpendCents).toBe(0);

        test.info().annotations.push({
            type: 'org-billing-scope',
            description:
                "A registered company org links a billable Work, but that Work's budget/usage is owner-scoped (work) + cross-tenant isolated (403). Org registration creates no org billing scope; plan + account usage stay user-keyed.",
        });
    });
});
