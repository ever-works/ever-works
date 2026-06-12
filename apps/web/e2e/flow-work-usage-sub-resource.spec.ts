import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-usage-sub-resource — the per-Work USAGE sub-resource
 * (`UsageController @Controller('api/works/:workId/usage')`, AuthSessionGuard)
 * of the Ever Works platform, driven as real INTEGRATION flows against the live
 * API. This file deliberately pins the GAPS the two heavy sibling specs leave
 * open on the SAME controller, NOT their already-covered ground.
 *
 * Every status code, message and JSON shape asserted below was PROBED against
 * the LIVE API at http://127.0.0.1:3100 before being written (2026-06-12).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — the three usage SUB-ROUTES are heavily covered already:
 *
 *   - `flow-usage-tracking.spec.ts` pins, on this controller: the summary
 *     ATTRIBUTION shape (perPlugin/totalSpendCents zero-state), the CSV export
 *     column/filename/no-store/format contract, the trend daily-bucket envelope,
 *     the ?period grammar 400s (garbage / month-13), the admin /admin/usage
 *     guard, the OWNER-allowed / NON-MEMBER-403 / MISSING-404 / unauth-401
 *     matrix across all three surfaces, and usage↔budget reconciliation.
 *   - `flow-budget-caps-perwork.spec.ts` pins the per-Work budget CAP CRUD and
 *     its effect on the usage SUMMARY (globalBudget join, EUR currency follow,
 *     percentUsed = round(spend/cap*100)), plus the post-hard-delete collapse.
 *
 *   Neither sibling covers the contracts pinned HERE:
 *     1. THE INDEX ROUTE DOES NOT EXIST. The controller exposes ONLY the three
 *        leaf actions (summary/export/trend) — the bare `GET …/usage` has no
 *        handler → 404. (Both siblings only ever hit the leaves.)
 *     2. THE MEMBER READ-ACCESS BRANCH (the POSITIVE side of assertReadAccess).
 *        Every sibling tests owner(200) + stranger(403); NONE adds a REAL
 *        work-member and proves a non-owner VIEWER gets 200 on all three
 *        surfaces — and that REMOVING the member REVOKES it (200 → 403). This is
 *        the `workMemberRepository.isMember()` arm of the access gate.
 *     3. THE PERIOD-WINDOW ENGINE AT THE BOUNDARIES. Siblings only sweep the
 *        current month + one March window + two 400 cases. HERE: the Dec→next-Jan
 *        YEAR ROLLOVER, the 29-day leap-Feb window, a far-future window, and the
 *        invalid-MONTH (2026-00 / 2026-13) vs invalid-PERIOD (2026-1, missing
 *        zero-pad) message SPLIT — proven UNIFORMLY across summary, export AND
 *        trend (one period engine behind all three; the filename + window track it).
 *     4. PLUGIN-SCOPED BUDGET NEVER JOINS THE SUMMARY. The summary's
 *        `globalBudget` join is keyed on the GLOBAL budget row only
 *        (`budgetRepository.findGlobal`); a PLUGIN-scoped cap row exists but is
 *        NOT surfaced on the summary (globalBudget stays null). Distinct from the
 *        sibling's global-cap join.
 *     5. CROSS-WORK / CROSS-USER NON-LEAK. A member of Work A is a STRANGER to
 *        Work B (403, not a leak); each summary echoes EXACTLY its own requested
 *        workId; two users' usage reads are strict per-work silos.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live, 2026-06-12):
 *   GET /api/works/:id/usage (bare, no leaf) → 404 (no index handler).
 *   GET /api/works/:id/usage/summary → 200 { workId, periodStart(ISO 1st-of-month),
 *     periodEnd(ISO 1st-of-next-month), periodLabel('Month YYYY'), currency:'usd',
 *     totalSpendCents:0, perPlugin:[], globalBudget:null }.
 *   Work member: POST /api/works/:id/members {email,role:'viewer'} → 200
 *     { status:'success', member:{ id, userId, … } }. Member then reads
 *     summary/export/trend → 200. DELETE /api/works/:id/members/:memberId → 200
 *     → member's subsequent usage read → 403 'does not have access'.
 *   ?period boundaries (summary): 2026-12 → start 2026-12-01 / end 2027-01-01,
 *     label 'December 2026'; 2024-02 → start 2024-02-01 / end 2024-03-01 (29d leap),
 *     label 'February 2024'; 2099-12 → end 2100-01-01. Same windows on
 *     export (filename usage-<id>-2026-12.csv) and trend.
 *   ?period invalid: 2026-00 & 2026-13 → 400 "Invalid month in period…";
 *     2026-1 / 26-01 / 2026-12-01 / 2026_01 / not → 400 "Invalid period…".
 *   PLUGIN budget: POST /api/works/:id/budgets {scope:'plugin',pluginId:'openai',
 *     monthlyCapCents,…} → 201 — but summary.globalBudget STAYS null.
 *   Cross-work: owner of Work B reading Work A's usage (A exists, B's owner is a
 *     non-member of A) → 403 'User does not have access to work <A>'.
 *
 * Cross-spec isolation: every flow uses a FRESH registerUserViaAPI() user. This
 * file performs ZERO account-wide cap mutations, so it can never shadow a
 * sibling's cap. Unique stamps come from a per-test counter seeded off the test
 * title, NOT a module-scope clock. Assertions pin shape / access / window /
 * self-scoping / zero-state, never a billed number or a global count.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH_START_RE = /^\d{4}-\d{2}-01T00:00:00\.000Z$/;

interface UsageSummary {
    workId: string;
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
    currency: string;
    totalSpendCents: number;
    perPlugin: { pluginId: string; capability: string; units: number; costCents: number }[];
    globalBudget: {
        id: string;
        monthlyCapCents: number;
        allowOverage: boolean;
        currency: string;
        percentUsed: number;
    } | null;
}

/** Per-test monotonic stamp — built from the test title, NOT a module clock. */
function stamper(title: string): () => string {
    let n = 0;
    const base = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24);
    return () => `${base}-${n++}`;
}

function usageUrl(workId: string, leaf: string, qs = ''): string {
    return `${API_BASE}/api/works/${workId}/usage/${leaf}${qs}`;
}

async function getSummary(
    request: APIRequestContext,
    token: string,
    workId: string,
    qs = '',
): Promise<UsageSummary> {
    const res = await request.get(usageUrl(workId, 'summary', qs), {
        headers: authedHeaders(token),
    });
    expect(res.status(), `summary status body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Add a work member by email. Probed: POST /members → 201 { member:{ id } }. */
async function addMember(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    email: string,
    role: 'viewer' | 'editor' | 'manager',
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(ownerToken),
        data: { email, role },
    });
    expect(res.status(), `add member body=${await res.text().catch(() => '')}`).toBe(201);
    const body = (await res.json()) as { member: { id: string; userId: string } };
    expect(body.member.id).toMatch(UUID_RE);
    return body.member.id;
}

test.describe('flow: per-Work usage sub-resource — index/member-access/period-engine/scoping gaps', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 1 — THE INDEX ROUTE DOES NOT EXIST. The controller exposes only the
    // three leaf actions; the bare collection route has no handler. This pins the
    // route surface so a future @Get() index can't silently appear (and leak an
    // un-shaped payload). The leaves still 200, proving it is the index that 404s,
    // not the whole controller.
    // ──────────────────────────────────────────────────────────────────
    test('the bare /usage index has no handler (404) while the three leaf actions all 200 for the owner', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-index-${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // The bare collection route is NOT mapped — only summary/export/trend are.
        const bare = await request.get(`${API_BASE}/api/works/${work.id}/usage`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(bare.status(), 'bare …/usage has no index handler → 404').toBe(404);

        // A trailing slash on the bare route is likewise unmapped (no index).
        const bareSlash = await request.get(`${API_BASE}/api/works/${work.id}/usage/`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(bareSlash.status(), 'trailing-slash bare …/usage/ → 404').toBe(404);

        // The three real leaves all resolve 200 for the owner — so the 404 above is
        // specifically the missing INDEX, not a broken controller mount.
        for (const leaf of ['summary', 'export', 'trend'] as const) {
            const res = await request.get(usageUrl(work.id, leaf), {
                headers: authedHeaders(owner.access_token),
            });
            expect(res.status(), `leaf ${leaf} resolves for the owner`).toBe(200);
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 2 — THE MEMBER READ-ACCESS BRANCH (positive side of assertReadAccess).
    // assertReadAccess allows owner OR work-member. The siblings only test owner
    // (200) + stranger (403); HERE we add a REAL viewer member and prove the
    // isMember() arm grants 200 on ALL THREE surfaces — then REMOVE the member and
    // prove access is REVOKED (200 → 403). This is the read-access lifecycle the
    // usage sub-resource inherits from work membership.
    // ──────────────────────────────────────────────────────────────────
    test('a non-owner VIEWER member can read all three usage surfaces (200); removing the member revokes it (→ 403)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-member-${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // Before membership, the would-be member is a STRANGER → 403 (the negative
        // baseline that the positive grant must flip).
        for (const leaf of ['summary', 'export', 'trend'] as const) {
            const pre = await request.get(usageUrl(work.id, leaf), {
                headers: authedHeaders(member.access_token),
            });
            expect(pre.status(), `pre-membership ${leaf} → 403`).toBe(403);
        }

        // Grant the lowest trust tier (viewer). assertReadAccess gates on MEMBERSHIP,
        // not role, so even a viewer reads usage.
        const memberId = await addMember(
            request,
            owner.access_token,
            work.id,
            member.email,
            'viewer',
        );

        // The member now reads every surface — and the summary it sees echoes the
        // SAME workId (no cross-work bleed) and is the well-formed zero-state.
        const memberSummary = await getSummary(request, member.access_token, work.id);
        expect(memberSummary.workId, 'member reads THIS work').toBe(work.id);
        expect(memberSummary.totalSpendCents, 'no billed spend in CI').toBe(0);
        expect(memberSummary.perPlugin).toHaveLength(0);

        const memberExport = await request.get(usageUrl(work.id, 'export'), {
            headers: authedHeaders(member.access_token),
        });
        expect(memberExport.status(), 'member can export').toBe(200);
        expect(memberExport.headers()['content-type']).toContain('text/csv');

        const memberTrend = await request.get(usageUrl(work.id, 'trend'), {
            headers: authedHeaders(member.access_token),
        });
        expect(memberTrend.status(), 'member can read the trend').toBe(200);

        // ── REVOKE: remove the member. Access collapses back to 403 on every
        //    surface — the usage gate is re-evaluated per request against live
        //    membership, so a removed member loses the read immediately.
        const del = await request.delete(`${API_BASE}/api/works/${work.id}/members/${memberId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(del.status(), 'owner removes the member → 200').toBe(200);

        for (const leaf of ['summary', 'export', 'trend'] as const) {
            const post = await request.get(usageUrl(work.id, leaf), {
                headers: authedHeaders(member.access_token),
            });
            expect(post.status(), `post-removal ${leaf} → 403 (access revoked)`).toBe(403);
            expect(
                JSON.stringify(await post.json()),
                `${leaf} revocation names the access failure`,
            ).toContain('does not have access');
        }

        // The OWNER is unaffected by the member churn — still 200.
        expect((await getSummary(request, owner.access_token, work.id)).workId).toBe(work.id);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 3 — THE PERIOD ENGINE AT THE BOUNDARIES (summary). The window is the
    // calendar-month UTC engine: a YYYY-MM resolves to the 1st-of-that-month →
    // 1st-of-next-month half-open pair, with a human 'Month YYYY' label. We sweep
    // the boundaries the siblings skip: Dec→next-Jan year rollover, the 29-day
    // leap-Feb window, and a far-future year — each a clean rollover.
    // ──────────────────────────────────────────────────────────────────
    test('summary ?period resolves boundary windows: Dec rolls to next Jan, leap-Feb is 29 days, far-future rolls cleanly — each with the right label', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-period-${Date.now()}`,
        });

        // December: the period END rolls into the NEXT YEAR (2027-01), exercising the
        // Date.UTC(year, month, 1) month-overflow → year carry. Label is 'December 2026'.
        const dec = await getSummary(request, owner.access_token, work.id, '?period=2026-12');
        expect(dec.periodStart).toBe('2026-12-01T00:00:00.000Z');
        expect(dec.periodEnd, 'Dec window ends on the 1st of the NEXT YEAR').toBe(
            '2027-01-01T00:00:00.000Z',
        );
        expect(dec.periodLabel).toBe('December 2026');
        expect(dec.totalSpendCents).toBe(0);

        // Leap February (2024) — the window is the SHORTER 28→29 span, but always
        // ends on the 1st of March (the engine never hard-codes 30/31). 2024-02-01 →
        // 2024-03-01 is exactly 29 days (2024 is a leap year), strictly < 31.
        const feb = await getSummary(request, owner.access_token, work.id, '?period=2024-02');
        expect(feb.periodStart).toBe('2024-02-01T00:00:00.000Z');
        expect(feb.periodEnd, 'Feb window ends on the 1st of March').toBe(
            '2024-03-01T00:00:00.000Z',
        );
        expect(feb.periodLabel).toBe('February 2024');
        const febSpanDays =
            (Date.parse(feb.periodEnd) - Date.parse(feb.periodStart)) / (24 * 60 * 60 * 1000);
        expect(febSpanDays, 'leap-Feb window is 29 days (< the 30/31 of other months)').toBe(29);

        // A far-future December rolls into the next CENTURY (2099-12 → 2100-01),
        // proving the rollover is pure arithmetic, not a lookup table.
        const future = await getSummary(request, owner.access_token, work.id, '?period=2099-12');
        expect(future.periodStart).toBe('2099-12-01T00:00:00.000Z');
        expect(future.periodEnd).toBe('2100-01-01T00:00:00.000Z');
        expect(future.periodLabel).toBe('December 2099');

        // Every boundary window is still a clean first-of-month UTC pair, forward.
        for (const s of [dec, feb, future]) {
            expect(s.periodStart).toMatch(MONTH_START_RE);
            expect(s.periodEnd).toMatch(MONTH_START_RE);
            expect(Date.parse(s.periodEnd)).toBeGreaterThan(Date.parse(s.periodStart));
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 4 — THE PERIOD GRAMMAR'S TWO ERROR CLASSES, UNIFORM ACROSS SURFACES.
    // The resolver first regex-checks ^YYYY-MM$ ('Invalid period…'), THEN range-
    // checks the month 1..12 ('Invalid month…'). These two distinct messages must
    // hold IDENTICALLY on summary, export AND trend — one resolver behind all
    // three. A malformed window can never produce an off-by-month read on ANY leaf.
    // ──────────────────────────────────────────────────────────────────
    test('the period grammar splits into Invalid-period (shape) vs Invalid-month (range) and applies identically to summary, export and trend', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-grammar-${Date.now()}`,
        });
        const h = authedHeaders(owner.access_token);

        // SHAPE failures (regex miss) → 'Invalid period'. Missing zero-pad (2026-1),
        // a 2-digit year, an over-long date, and an underscore all fail the ^YYYY-MM$.
        const shapeBad = ['2026-1', '26-01', '2026-12-01', '2026_01', 'not-a-period'] as const;
        // RANGE failures (month out of 1..12) → 'Invalid month'.
        const rangeBad = ['2026-00', '2026-13'] as const;

        for (const leaf of ['summary', 'export', 'trend'] as const) {
            for (const period of shapeBad) {
                const res = await request.get(usageUrl(work.id, leaf, `?period=${period}`), {
                    headers: h,
                });
                expect(res.status(), `${leaf} period='${period}' → 400`).toBe(400);
                expect(
                    JSON.stringify(await res.json()),
                    `${leaf} '${period}' is a SHAPE failure`,
                ).toContain('Invalid period');
            }
            for (const period of rangeBad) {
                const res = await request.get(usageUrl(work.id, leaf, `?period=${period}`), {
                    headers: h,
                });
                expect(res.status(), `${leaf} period='${period}' → 400`).toBe(400);
                expect(
                    JSON.stringify(await res.json()),
                    `${leaf} '${period}' is a RANGE failure`,
                ).toContain('Invalid month');
            }
            // The well-formed 'current' alias is accepted on every leaf (proving the
            // 400s above are the grammar gate, not a dead route).
            const ok = await request.get(usageUrl(work.id, leaf, '?period=current'), {
                headers: h,
            });
            expect(ok.status(), `${leaf} period=current → 200`).toBe(200);
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 5 — ONE PERIOD ENGINE BEHIND ALL THREE LEAVES. A single ?period must
    // produce the SAME window on the summary + trend, and the SAME YYYY-MM slug in
    // the export filename — so a chart, a total and a downloaded CSV never disagree
    // about which month they describe. We pin the convergence at a BOUNDARY month
    // (December, where the year rolls over) to catch any per-leaf rollover drift.
    // ──────────────────────────────────────────────────────────────────
    test('a single ?period yields byte-identical windows on summary + trend AND a matching YYYY-MM export filename (boundary month)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-converge-${Date.now()}`,
        });
        const h = authedHeaders(owner.access_token);

        const summary = await getSummary(request, owner.access_token, work.id, '?period=2026-12');

        const trendRes = await request.get(usageUrl(work.id, 'trend', '?period=2026-12'), {
            headers: h,
        });
        expect(trendRes.status()).toBe(200);
        const trend = (await trendRes.json()) as {
            periodStart: string;
            periodEnd: string;
            granularity: string;
            buckets: unknown[];
        };

        // The trend window EQUALS the summary window byte-for-byte (same resolver).
        expect(trend.periodStart, 'trend start == summary start').toBe(summary.periodStart);
        expect(trend.periodEnd, 'trend end == summary end').toBe(summary.periodEnd);
        expect(trend.granularity).toBe('day');
        expect(Array.isArray(trend.buckets)).toBe(true);

        // The export filename's YYYY-MM slug tracks the SAME period — at the Dec
        // boundary the slug is 2026-12 (the START month), not the rolled-over Jan.
        const exportRes = await request.get(usageUrl(work.id, 'export', '?period=2026-12'), {
            headers: h,
        });
        expect(exportRes.status()).toBe(200);
        const disposition = exportRes.headers()['content-disposition'] ?? '';
        expect(disposition, 'filename slug is the period START month').toContain(
            `usage-${work.id}-2026-12.csv`,
        );
        // The CSV body for an empty period is the header line alone — reconciling with
        // the summary's totalSpendCents 0 (no data rows → no spend).
        const lines = (await exportRes.text()).split('\n').filter((l) => l.length > 0);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toBe(
            'occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId',
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 6 — A PLUGIN-SCOPED BUDGET NEVER JOINS THE SUMMARY. The summary's
    // `globalBudget` field is keyed on the GLOBAL budget row only
    // (budgetRepository.findGlobal). A PLUGIN-scoped cap row is a real budget but
    // is NOT the global cap, so it must NOT surface on the summary — globalBudget
    // stays null. Then a GLOBAL row DOES join, proving the field is scope-specific.
    // ──────────────────────────────────────────────────────────────────
    test('a plugin-scoped budget does NOT surface on the usage summary (globalBudget stays null); only a GLOBAL-scope cap joins', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-pluginbudget-${Date.now()}`,
        });
        const h = authedHeaders(owner.access_token);

        // Baseline: no budget of any scope → globalBudget null.
        const base = await getSummary(request, owner.access_token, work.id);
        expect(base.globalBudget, 'no budget → globalBudget null').toBeNull();

        // Create a PLUGIN-scoped cap (a real WorkBudget row, but scope='plugin').
        const pluginBudget = await request.post(`${API_BASE}/api/works/${work.id}/budgets`, {
            headers: h,
            data: {
                scope: 'plugin',
                pluginId: 'openai',
                monthlyCapCents: 5000,
                allowOverage: true,
            },
        });
        expect(
            pluginBudget.status(),
            `plugin budget create body=${await pluginBudget.text().catch(() => '')}`,
        ).toBe(201);

        // The summary STILL reports globalBudget null — a plugin cap is not the
        // global cap, so the summary's global-cap join does not pick it up. The
        // per-plugin attribution array is also still empty (no billed events in CI).
        const afterPlugin = await getSummary(request, owner.access_token, work.id);
        expect(
            afterPlugin.globalBudget,
            'a plugin-scoped budget does NOT join the summary global-cap slot',
        ).toBeNull();
        expect(afterPlugin.perPlugin, 'no billed events → empty attribution').toHaveLength(0);
        expect(afterPlugin.currency, 'currency falls back to usd absent a GLOBAL budget').toBe(
            'usd',
        );

        // Now add a GLOBAL-scope cap — THIS one joins. The contrast proves the
        // summary's globalBudget is keyed on the global scope specifically.
        const globalBudget = await request.post(`${API_BASE}/api/works/${work.id}/budgets`, {
            headers: h,
            data: { scope: 'global', monthlyCapCents: 10000, allowOverage: false },
        });
        expect(globalBudget.status()).toBe(201);

        const afterGlobal = await getSummary(request, owner.access_token, work.id);
        expect(afterGlobal.globalBudget, 'a GLOBAL-scope cap DOES join the summary').not.toBeNull();
        expect(afterGlobal.globalBudget?.monthlyCapCents).toBe(10000);
        expect(
            afterGlobal.globalBudget?.percentUsed,
            'round(0/10000*100) = 0 with no billed spend',
        ).toBe(0);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 7 — CROSS-WORK / CROSS-USER NON-LEAK. A user who is a MEMBER of Work A
    // is, by default, a STRANGER to Work B (membership is per-work). Reading B's
    // usage → 403 (not a leak, not a 404 either — B exists). And each summary
    // echoes EXACTLY its own requested workId, so two works under two users are
    // strict, self-keyed silos.
    // ──────────────────────────────────────────────────────────────────
    test('membership is per-work: a member of Work A is a stranger to Work B (403); each summary echoes only its own workId', async ({
        request,
    }) => {
        const s = stamper('cross-work-silo');
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        expect(userA.user.id).not.toBe(userB.user.id);

        const workA = await createWorkViaAPI(request, userA.access_token, {
            name: `Silo Work A ${s()}`,
            slug: `silo-work-a-${s()}`.toLowerCase(),
        });
        const workB = await createWorkViaAPI(request, userB.access_token, {
            name: `Silo Work B ${s()}`,
            slug: `silo-work-b-${s()}`.toLowerCase(),
        });
        expect(workA.id).not.toBe(workB.id);

        // Make userB a MEMBER of Work A (so userB is genuinely a trusted member —
        // but ONLY of A). Reading A's usage works; reading B's own usage works.
        await addMember(request, userA.access_token, workA.id, userB.email, 'viewer');
        const bReadsA = await getSummary(request, userB.access_token, workA.id);
        expect(bReadsA.workId, "B (a member of A) reads A's usage").toBe(workA.id);

        // userA is the OWNER of A but has NO relationship to B → 403 on B's usage.
        // B exists, so this is an ACCESS denial (403), never a 404 (existence is not
        // the secret; the usage is) and never a 200 (no cross-work leak).
        const aReadsB = await request.get(usageUrl(workB.id, 'summary'), {
            headers: authedHeaders(userA.access_token),
        });
        expect(aReadsB.status(), "A (stranger to B) reading B's usage → 403").toBe(403);
        expect(JSON.stringify(await aReadsB.json())).toContain(
            `does not have access to work ${workB.id}`,
        );

        // Each owner's own-work summary echoes EXACTLY its own workId — no shared
        // row, no id bleed between the two silos.
        const aOwnsA = await getSummary(request, userA.access_token, workA.id);
        const bOwnsB = await getSummary(request, userB.access_token, workB.id);
        expect(aOwnsA.workId).toBe(workA.id);
        expect(bOwnsB.workId).toBe(workB.id);
        expect(aOwnsA.workId).not.toBe(bOwnsB.workId);
        // Both are the well-formed zero-state — neither portfolio bills in CI.
        expect(aOwnsA.totalSpendCents).toBe(0);
        expect(bOwnsB.totalSpendCents).toBe(0);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 8 — THE BARE INDEX IS ROUTE-404 (NOT AUTH-GATED) WHILE THE LEAVES ARE
    // SESSION-GATED + THE ID-RESOLUTION ORDER. The un-mapped collection route 404s
    // BEFORE the session guard (route-not-found is decided first), so it is 404
    // whether or not a token is present — unlike a mapped leaf, which is 401 unauth.
    // And on a leaf the controller resolves the Work via findById BEFORE the
    // membership check — so a missing/malformed id is 404 (not 403) even though the
    // 403 is what a real-but-forbidden work returns. Pins the ordering precisely.
    // ──────────────────────────────────────────────────────────────────
    test('the un-mapped bare index is 404 with OR without auth (route-level, not the session guard), while a leaf is 401 unauth; ids resolve before the access check (missing→404, foreign→403)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-resolve-order-${Date.now()}`,
        });

        // The bare collection route is UN-MAPPED → route-not-found 404 is decided
        // before the session guard runs, so it is 404 BOTH unauth AND authed (the
        // 404 is route-level, not an auth outcome).
        const anonBare = await request.get(`${API_BASE}/api/works/${work.id}/usage`);
        expect(anonBare.status(), 'unauth bare index → 404 (route-not-found, pre-guard)').toBe(404);
        const authedBare = await request.get(`${API_BASE}/api/works/${work.id}/usage`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(authedBare.status(), 'authed bare index → still 404 (no index handler)').toBe(404);

        // Contrast: a MAPPED leaf is session-gated → 401 unauth (the guard DOES run on
        // routes that exist). This is what distinguishes a missing route from a gated one.
        const anonLeaf = await request.get(usageUrl(work.id, 'summary'));
        expect(anonLeaf.status(), 'unauth leaf → 401 (mapped route, session guard runs)').toBe(401);

        const FAKE_UUID = '99999999-9999-4999-8999-999999999999';

        // A well-formed-but-missing work id → 404 'not found': findById misses before
        // the membership check runs (so a non-existent work is reported as MISSING).
        const missing = await request.get(usageUrl(FAKE_UUID, 'summary'), {
            headers: authedHeaders(owner.access_token),
        });
        expect(missing.status(), 'missing work id → 404 (resolved before access)').toBe(404);
        expect(JSON.stringify(await missing.json())).toContain('not found');

        // A NON-uuid id is ALSO 404 here (the controller has NO ParseUUIDPipe, so
        // findById simply misses → 404, never a 400).
        const malformed = await request.get(usageUrl('not-a-uuid', 'summary'), {
            headers: authedHeaders(owner.access_token),
        });
        expect(malformed.status(), 'malformed id → 404 (no ParseUUIDPipe)').toBe(404);

        // A REAL work the caller can't access → 403 (existence confirmed, access
        // denied) — the contrast that proves findById runs BEFORE isMember, and the
        // two failure modes (missing vs forbidden) stay honest and distinct.
        const forbidden = await request.get(usageUrl(work.id, 'summary'), {
            headers: authedHeaders(stranger.access_token),
        });
        expect(forbidden.status(), 'real foreign work → 403 (resolved, then denied)').toBe(403);
        expect(JSON.stringify(await forbidden.json())).toContain('does not have access');
    });
});
