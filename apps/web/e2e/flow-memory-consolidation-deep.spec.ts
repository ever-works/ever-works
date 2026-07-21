/**
 * Memory Consolidation — dry-run-first promote / synthesize / supersede, DEEP (#1711).
 *
 * The org-wide Memory curation pass (`POST /api/memory/consolidate`) shipped with
 * no dedicated e2e coverage. This file drives the real API against a live stack,
 * seeding org-level KB documents through `POST /api/organizations/:orgId/kb/documents`
 * and pinning the true report shape + status codes end-to-end:
 *
 *   • dry-run by default — a bare POST returns a FULL plan and mutates NOTHING
 *     (report.dryRun === true, a "Dry run — no changes were persisted." note,
 *     and every feed document keeps consolidation === null afterwards)
 *   • `{ apply: true }` persists markers: the survivor of a near-duplicate group
 *     is PROMOTED (state 'promoted' + numeric score + reason + runAt) and the
 *     losers are SUPERSEDED (state 'superseded' + supersededById + reason),
 *     never deleted — the GET /api/memory feed reflects both
 *   • near-duplicate detection groups same-title docs; survivor = newest-then-id-asc
 *     (details.supersededPairs are [loserId, survivorId] pairs, survivor ∈ promotedIds)
 *   • idempotency: a second apply run leaves already-superseded docs alone
 *     (superseded === 0), so re-running is safe
 *   • synthesis (3+ duplicate cluster, inheritable class) is env-adaptive — a
 *     configured provider projects synthesized=1 in the dry-run PLAN, but the
 *     APPLY path downgrades a failing/keyless provider to a note and reports 0;
 *     assertions tolerate synthesized ∈ {0, 1}
 *   • no active Organization ⇒ an empty report (never a cross-tenant scan); the
 *     Organization is resolved from the request SCOPE CONTEXT, not a param
 *   • validation: `apply` must be boolean (400), unknown body props rejected (400)
 *   • auth gating (401) on both /api/memory and /api/memory/consolidate
 *   • org isolation: a second user's active org is never consolidated against the
 *     first user's documents (scope-context bound, no orgId param to attack)
 *   • GET /api/memory companion: aggregation + counts + faceted shape, class
 *     filter, invalid-enum / limit-floor validation
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before any assertion was written. Org-level KB docs are restricted
 *    to the inheritable classes (legal / style / seo); those are what the pass
 *    scans here (org docs carry workId === null in the feed).
 *
 * Isolation discipline: every test builds a FRESH registerUserViaAPI() owner and
 * a lazily-minted org. Fully API-orchestrated (safe `flow-` prefix, not matched
 * by the no-auth testIgnore regex), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

const CONSOLIDATE_URL = `${API_BASE}/api/memory/consolidate`;
const MEMORY_URL = `${API_BASE}/api/memory`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A fresh owner + their lazily-minted org, with pre-built auth headers. */
interface OrgCtx {
    user: RegisteredUser;
    token: string;
    headers: { Authorization: string };
    orgId: string;
}

async function buildOrgCtx(request: APIRequestContext): Promise<OrgCtx> {
    const user = await registerUserViaAPI(request);
    const org = await createOrganizationViaAPI(request, user.access_token, `Mem Org ${stamp()}`);
    return {
        user,
        token: user.access_token,
        headers: authedHeaders(user.access_token),
        orgId: org.id,
    };
}

/** Seed one org-level KB document (only legal/style/seo are org-authorable). */
async function createOrgDoc(
    request: APIRequestContext,
    ctx: OrgCtx,
    doc: {
        path: string;
        title: string;
        class: 'legal' | 'style' | 'seo';
        body: string;
        tags?: string[];
    },
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/organizations/${ctx.orgId}/kb/documents`, {
        headers: ctx.headers,
        data: doc,
    });
    expect(res.status(), `createOrgDoc body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

interface ConsolidationReport {
    scanned: number;
    promoted: number;
    synthesized: number;
    superseded: number;
    dryRun: boolean;
    notes: string[];
    details: {
        promotedIds: string[];
        supersededPairs: [string, string][];
        synthesizedIds: string[];
    };
}

async function consolidate(
    request: APIRequestContext,
    headers: { Authorization: string },
    apply?: boolean,
): Promise<ConsolidationReport> {
    const res = await request.post(CONSOLIDATE_URL, {
        headers,
        data: apply === undefined ? {} : { apply },
    });
    expect(res.status(), `consolidate body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getMemory(
    request: APIRequestContext,
    headers: { Authorization: string },
    qs = '',
): Promise<{
    documents: Array<{ id: string; class: string; workId: string | null; consolidation: unknown }>;
    counts: { documents: number; indexed: number };
    facets: { types: unknown[]; works: unknown[]; statuses: unknown[]; sources: unknown[] };
}> {
    const res = await request.get(`${MEMORY_URL}${qs}`, { headers });
    expect(res.status(), `getMemory body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Memory Consolidation — dry-run preview (writes nothing)', () => {
    test('a bare POST returns the full report shape, dryRun:true, and a dry-run note', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await createOrgDoc(request, ctx, {
            path: `legal/plan-${stamp()}.md`,
            title: `Plan ${stamp()}`,
            class: 'legal',
            body: 'a single document worth previewing in the consolidation plan here.',
        });
        const report = await consolidate(request, ctx.headers);
        expect(report.dryRun).toBe(true);
        expect(report.scanned).toBe(1);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toBe(0);
        expect(Array.isArray(report.notes)).toBe(true);
        expect(report.notes.some((n) => /dry run/i.test(n))).toBe(true);
        expect(Array.isArray(report.details.promotedIds)).toBe(true);
        expect(Array.isArray(report.details.supersededPairs)).toBe(true);
        // A dry run never materializes synthesis documents, even when it projects a count.
        expect(report.details.synthesizedIds).toEqual([]);
    });

    test('a dry run leaves every feed document unmarked (no mutation)', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        await createOrgDoc(request, ctx, {
            path: `style/one-${stamp()}.md`,
            title: 'Marker Title',
            class: 'style',
            body: 'identical body identical body identical body identical body one.',
        });
        await createOrgDoc(request, ctx, {
            path: `style/two-${stamp()}.md`,
            title: 'Marker Title',
            class: 'style',
            body: 'different content about mountains rivers valleys and clouds passing by.',
        });
        const preview = await consolidate(request, ctx.headers, false);
        expect(preview.superseded).toBe(1);
        // …but nothing was persisted: the feed rows still carry consolidation === null.
        const feed = await getMemory(request, ctx.headers);
        for (const doc of feed.documents) {
            expect(doc.consolidation).toBeNull();
        }
    });

    test('no active Organization ⇒ an empty report with the no-org note', async ({ request }) => {
        const user = await registerUserViaAPI(request); // never creates an org
        const report = await consolidate(request, authedHeaders(user.access_token), true);
        expect(report).toMatchObject({ scanned: 0, promoted: 0, synthesized: 0, superseded: 0 });
        expect(report.details.promotedIds).toEqual([]);
        expect(report.details.supersededPairs).toEqual([]);
        expect(report.notes.some((n) => /no active organization/i.test(n))).toBe(true);
    });

    test('an org with zero documents scans nothing', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const report = await consolidate(request, ctx.headers);
        expect(report.scanned).toBe(0);
        expect(report.promoted).toBe(0);
        expect(report.superseded).toBe(0);
        expect(report.dryRun).toBe(true);
    });

    test('two distinct documents → nothing superseded, both promoted', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const a = await createOrgDoc(request, ctx, {
            path: `legal/cookie-${stamp()}.md`,
            title: `Cookie Policy ${stamp()}`,
            class: 'legal',
            body: 'cookies and tracking pixels remember your saved preferences on this site.',
        });
        const b = await createOrgDoc(request, ctx, {
            path: `style/tone-${stamp()}.md`,
            title: `Tone Guide ${stamp()}`,
            class: 'style',
            body: 'friendly warm concise tone across every customer facing surface always here.',
        });
        const report = await consolidate(request, ctx.headers);
        expect(report.superseded).toBe(0);
        expect(report.details.supersededPairs).toEqual([]);
        expect(report.promoted).toBe(2);
        expect(report.details.promotedIds).toContain(a);
        expect(report.details.promotedIds).toContain(b);
    });

    test('two same-title near-duplicates → 1 promoted survivor / 1 superseded loser', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const a = await createOrgDoc(request, ctx, {
            path: `legal/priv-a-${stamp()}.md`,
            title: 'Privacy Policy',
            class: 'legal',
            body: 'we respect your privacy and protect your data at all times everywhere.',
        });
        const b = await createOrgDoc(request, ctx, {
            path: `legal/priv-b-${stamp()}.md`,
            title: 'Privacy Policy',
            class: 'legal',
            body: 'a totally unrelated paragraph about gardening seeds soil and sunlight today.',
        });
        const report = await consolidate(request, ctx.headers);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toBe(1);
        expect(report.synthesized).toBe(0); // synthesis needs a cluster of 3+
        expect(report.details.supersededPairs).toHaveLength(1);

        // The pair is [loserId, survivorId]; the survivor is the promoted one.
        const [loserId, survivorId] = report.details.supersededPairs[0];
        expect([a, b].sort()).toEqual([loserId, survivorId].sort());
        expect(loserId).not.toBe(survivorId);
        expect(report.details.promotedIds).toContain(survivorId);
        expect(report.details.promotedIds).not.toContain(loserId);
    });

    test('a cluster of 3 → 2 superseded (shared survivor), 1 promoted, synthesis env-adaptive', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const ids: string[] = [];
        for (const s of ['a', 'b', 'c']) {
            ids.push(
                await createOrgDoc(request, ctx, {
                    path: `seo/dup-${s}-${stamp()}.md`,
                    title: 'SEO Keyword Strategy',
                    class: 'seo',
                    body: `variant ${s} distinct wording ${s} ${s} ${s} covering subtopic ${s} only.`,
                }),
            );
        }
        const report = await consolidate(request, ctx.headers);
        expect(report.scanned).toBe(3);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toBe(2);
        expect(report.details.supersededPairs).toHaveLength(2);
        // Both losers point at the same single survivor, which is the promoted doc.
        const survivors = new Set(report.details.supersededPairs.map(([, survivor]) => survivor));
        expect(survivors.size).toBe(1);
        const survivorId = [...survivors][0];
        expect(report.details.promotedIds).toEqual([survivorId]);
        // Configured provider → dry-run PROJECTS synthesized=1; keyless CI → 0.
        expect([0, 1]).toContain(report.synthesized);
        expect(report.details.synthesizedIds).toEqual([]); // never materialized in a dry run
    });
});

test.describe('Memory Consolidation — apply (persist markers)', () => {
    test('apply:true promotes the survivor and supersedes the loser, persisted on the feed', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await createOrgDoc(request, ctx, {
            path: `style/voice-a-${stamp()}.md`,
            title: 'Voice Guide',
            class: 'style',
            body: 'use active voice and short sentences whenever possible in all our writing.',
        });
        await createOrgDoc(request, ctx, {
            path: `style/voice-b-${stamp()}.md`,
            title: 'Voice Guide',
            class: 'style',
            body: 'a paragraph about weather patterns ocean tides and the phases of the moon.',
        });
        const report = await consolidate(request, ctx.headers, true);
        expect(report.dryRun).toBe(false);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toBe(1);
        const [loserId, survivorId] = report.details.supersededPairs[0];

        const feed = await getMemory(request, ctx.headers);
        const byId = new Map(feed.documents.map((d) => [d.id, d.consolidation]));
        const survivorMarker = byId.get(survivorId) as Record<string, unknown>;
        expect(survivorMarker).toBeTruthy();
        expect(survivorMarker.state).toBe('promoted');
        expect(typeof survivorMarker.score).toBe('number');
        expect(typeof survivorMarker.reason).toBe('string');
        expect(typeof survivorMarker.runAt).toBe('string');

        const loserMarker = byId.get(loserId) as Record<string, unknown>;
        expect(loserMarker).toBeTruthy();
        expect(loserMarker.state).toBe('superseded');
        expect(loserMarker.supersededById).toBe(survivorId);
        expect(String(loserMarker.reason)).toMatch(/near-duplicate/i);
    });

    test('re-running apply is idempotent — already-superseded docs are left alone', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await createOrgDoc(request, ctx, {
            path: `legal/tos-a-${stamp()}.md`,
            title: 'Terms of Service',
            class: 'legal',
            body: 'these terms govern your use of the service and the platform in full.',
        });
        await createOrgDoc(request, ctx, {
            path: `legal/tos-b-${stamp()}.md`,
            title: 'Terms of Service',
            class: 'legal',
            body: 'an entirely separate note about recipes for baking bread at high altitude.',
        });
        const first = await consolidate(request, ctx.headers, true);
        expect(first.superseded).toBe(1);

        const second = await consolidate(request, ctx.headers, true);
        // The already-superseded loser is excluded from grouping the second time.
        expect(second.superseded).toBe(0);
        expect(second.details.supersededPairs).toEqual([]);
        expect(second.promoted).toBe(1); // the survivor stays promoted
    });

    test('apply on a 3-cluster supersedes 2 deterministically; synthesis stays env-adaptive', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        for (const s of ['a', 'b', 'c']) {
            await createOrgDoc(request, ctx, {
                path: `seo/apply-${s}-${stamp()}.md`,
                title: 'Structured Data Rules',
                class: 'seo',
                body: `cluster member ${s} unique tokens ${s} ${s} ${s} on facet ${s} exclusively.`,
            });
        }
        const report = await consolidate(request, ctx.headers, true);
        expect(report.dryRun).toBe(false);
        expect(report.superseded).toBe(2);
        expect(report.promoted).toBe(1);
        // Real synthesis only happens with a working provider; a keyless/failing
        // provider downgrades to a note and reports 0. Both are truthful.
        expect([0, 1]).toContain(report.synthesized);
        expect(report.details.synthesizedIds).toHaveLength(report.synthesized);
    });

    test('apply on distinct docs marks them all promoted, none superseded', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const a = await createOrgDoc(request, ctx, {
            path: `legal/uniq-a-${stamp()}.md`,
            title: `Refund Policy ${stamp()}`,
            class: 'legal',
            body: 'refunds are issued within thirty days for any unused eligible purchase here.',
        });
        const b = await createOrgDoc(request, ctx, {
            path: `seo/uniq-b-${stamp()}.md`,
            title: `Meta Tags ${stamp()}`,
            class: 'seo',
            body: 'every page must declare a unique title and a concise meta description tag.',
        });
        const report = await consolidate(request, ctx.headers, true);
        expect(report.superseded).toBe(0);
        expect(report.promoted).toBe(2);

        const feed = await getMemory(request, ctx.headers);
        const byId = new Map(feed.documents.map((d) => [d.id, d.consolidation]));
        for (const id of [a, b]) {
            expect((byId.get(id) as Record<string, unknown>).state).toBe('promoted');
        }
    });

    test('apply:false explicitly behaves like the default dry run and mutates nothing', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await createOrgDoc(request, ctx, {
            path: `style/df-a-${stamp()}.md`,
            title: 'Editorial Standards',
            class: 'style',
            body: 'prefer plain language and avoid jargon in all of our public writing.',
        });
        await createOrgDoc(request, ctx, {
            path: `style/df-b-${stamp()}.md`,
            title: 'Editorial Standards',
            class: 'style',
            body: 'a wholly different note about spreadsheet formulas and pivot table tricks.',
        });
        const report = await consolidate(request, ctx.headers, false);
        expect(report.dryRun).toBe(true);
        expect(report.superseded).toBe(1);
        const feed = await getMemory(request, ctx.headers);
        for (const doc of feed.documents) {
            expect(doc.consolidation).toBeNull();
        }
    });
});

test.describe('Memory Consolidation — validation & auth', () => {
    test('apply as a string → 400 (must be a boolean)', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const res = await request.post(CONSOLIDATE_URL, {
            headers: ctx.headers,
            data: { apply: 'yes' },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify(await res.json())).toMatch(/apply must be a boolean/i);
    });

    test('apply as a number → 400', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const res = await request.post(CONSOLIDATE_URL, {
            headers: ctx.headers,
            data: { apply: 123 },
        });
        expect(res.status()).toBe(400);
    });

    test('an unknown body property → 400 (forbidNonWhitelisted)', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const res = await request.post(CONSOLIDATE_URL, {
            headers: ctx.headers,
            data: { apply: false, sneaky: 'nope' },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify(await res.json())).toMatch(/should not exist/i);
    });

    test('no auth → 401 on both consolidate and the memory feed', async ({ request }) => {
        expect((await request.post(CONSOLIDATE_URL, { data: {} })).status()).toBe(401);
        expect((await request.get(MEMORY_URL)).status()).toBe(401);
    });
});

test.describe('Memory Consolidation — org isolation (scope-context bound)', () => {
    test("a second user's org is never consolidated against the first user's documents", async ({
        request,
    }) => {
        const alice = await buildOrgCtx(request);
        await createOrgDoc(request, alice, {
            path: `legal/a-secret-${stamp()}.md`,
            title: 'Shared Secret Policy',
            class: 'legal',
            body: 'alice private policy about internal confidential handling of sensitive records.',
        });
        await createOrgDoc(request, alice, {
            path: `legal/a-secret2-${stamp()}.md`,
            title: 'Shared Secret Policy',
            class: 'legal',
            body: 'a second unrelated alice note about office plant watering schedules weekly.',
        });
        const aliceReport = await consolidate(request, alice.headers);
        expect(aliceReport.superseded).toBe(1);
        const aliceSurvivor = aliceReport.details.supersededPairs[0][1];

        // Bob's own active org sees only his own (empty) memory — never Alice's docs.
        const bob = await buildOrgCtx(request);
        const bobReport = await consolidate(request, bob.headers, true);
        expect(bobReport.scanned).toBe(0);
        expect(bobReport.superseded).toBe(0);
        expect(bobReport.details.promotedIds).not.toContain(aliceSurvivor);

        // Alice's org is untouched by Bob's apply run.
        const aliceFeed = await getMemory(request, alice.headers);
        expect(aliceFeed.documents.every((d) => d.consolidation === null)).toBe(true);
    });

    test("consolidation is bounded to the caller's own active org (each report is self-contained)", async ({
        request,
    }) => {
        const owner = await buildOrgCtx(request);
        const ownDoc = await createOrgDoc(request, owner, {
            path: `style/own-${stamp()}.md`,
            title: `Own Only ${stamp()}`,
            class: 'style',
            body: 'the only document in this brand new organization scoped to its owner.',
        });
        const report = await consolidate(request, owner.headers);
        expect(report.scanned).toBe(1);
        expect(report.details.promotedIds).toEqual([ownDoc]);
        expect(report.superseded).toBe(0);
    });
});

test.describe('GET /api/memory — companion aggregation surface', () => {
    test('aggregation shape: documents + counts + facets; org docs carry workId null', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const id = await createOrgDoc(request, ctx, {
            path: `legal/agg-${stamp()}.md`,
            title: `Aggregated ${stamp()}`,
            class: 'legal',
            body: 'a document that should show up in the org-wide memory aggregation feed.',
            tags: ['policy', 'gdpr'],
        });
        const feed = await getMemory(request, ctx.headers);
        expect(feed.counts.documents).toBeGreaterThanOrEqual(1);
        expect(feed.counts.indexed).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(feed.facets.types)).toBe(true);
        expect(Array.isArray(feed.facets.statuses)).toBe(true);
        expect(Array.isArray(feed.facets.sources)).toBe(true);
        const row = feed.documents.find((d) => d.id === id)!;
        expect(row, 'seeded org doc should appear in the feed').toBeTruthy();
        expect(row.workId).toBeNull();
        expect(row.class).toBe('legal');
        expect(row.id).toMatch(UUID_RE);
        // Facet entries are { value, label, count }.
        const legalFacet = (feed.facets.types as Array<{ value: string; count: number }>).find(
            (f) => f.value === 'legal',
        );
        expect(legalFacet).toBeTruthy();
        expect(legalFacet!.count).toBeGreaterThanOrEqual(1);
    });

    test('class filter narrows the feed; invalid enum and limit floor → 400', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await createOrgDoc(request, ctx, {
            path: `legal/f1-${stamp()}.md`,
            title: `Legal One ${stamp()}`,
            class: 'legal',
            body: 'a legal class document used to verify the type facet filter narrows results.',
        });
        await createOrgDoc(request, ctx, {
            path: `style/f2-${stamp()}.md`,
            title: `Style One ${stamp()}`,
            class: 'style',
            body: 'a style class document that must be excluded when filtering by type legal.',
        });
        const legalOnly = await getMemory(request, ctx.headers, '?type=legal');
        expect(legalOnly.documents.length).toBeGreaterThanOrEqual(1);
        for (const d of legalOnly.documents) {
            expect(d.class).toBe('legal');
        }
        // Invalid enum value and out-of-range limit are both rejected by the query DTO.
        expect(
            (await request.get(`${MEMORY_URL}?type=bogus`, { headers: ctx.headers })).status(),
        ).toBe(400);
        expect(
            (await request.get(`${MEMORY_URL}?limit=0`, { headers: ctx.headers })).status(),
        ).toBe(400);
    });

    test('apply markers surface on the feed as promoted / superseded states', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await createOrgDoc(request, ctx, {
            path: `seo/mk-a-${stamp()}.md`,
            title: 'Canonical Tags',
            class: 'seo',
            body: 'always emit a canonical link tag on every indexable page of the site.',
        });
        await createOrgDoc(request, ctx, {
            path: `seo/mk-b-${stamp()}.md`,
            title: 'Canonical Tags',
            class: 'seo',
            body: 'a totally different note about keyboard shortcuts in the code editor daily.',
        });
        await consolidate(request, ctx.headers, true);
        const feed = await getMemory(request, ctx.headers);
        const states = feed.documents
            .map((d) => (d.consolidation as { state?: string } | null)?.state)
            .filter((s): s is string => typeof s === 'string');
        expect(states).toContain('promoted');
        expect(states).toContain('superseded');
    });
});
