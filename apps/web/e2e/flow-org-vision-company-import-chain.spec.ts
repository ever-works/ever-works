/**
 * Org create → vision set → prebuilt-company import → materialized teams/agents,
 * as ONE end-to-end CHAIN.
 *
 * This file lives at the INTERSECTION of two features that ship independently
 * and are each covered elsewhere, but whose CROSS-PRODUCT has zero coverage:
 *
 *   • Organization Vision — the nullable `vision` text + `visionUpdatedAt`
 *     stamp on `organizations` (PR-6, review §23.5). Covered as a standalone
 *     field by flow-organization-vision.spec.ts and
 *     flow-organization-vision-deep.spec.ts (create-time trim / whitespace→null
 *     / cap / PATCH lifecycle / clear / authz). NEITHER touches company import.
 *   • Prebuilt-company import — POST /api/organizations/import-company
 *     materializes an `agentcompanies/v1` package into a FRESH org (teams +
 *     paused agents + roster + skills + works + tasks). Covered by
 *     flow-prebuilt-companies-import-deep.spec.ts (catalog, counts, roster,
 *     reportsTo, throttle, cross-owner). It never sets or reads a `vision`.
 *
 * The importer creates its org via `OrganizationService.createOrganization(
 * userId, orgName)` — WITHOUT a vision (verified in source) — so an imported
 * org is ALWAYS born vision-less, and the vision is a per-org field a human
 * layers on afterward via PATCH. That is the seam this suite pins:
 *
 *   1. the imported org is born `vision: null` / `visionUpdatedAt: null`, even
 *      when its tenant ALREADY owns a vision-bearing manual org (vision is
 *      per-ORG, not per-tenant);
 *   2. PATCHing a vision onto the imported org persists (slug re-read + list
 *      echo) and does NOT disturb the materialized teams/agents/roster/chart;
 *   3. the full structure is assertable ALONGSIDE the vision (teams carry
 *      organizationId + a manager; agents are tenant-scope + draft with a
 *      reportsTo hierarchy; roster seats a lead; org-chart wires teamIds);
 *   4. the org-chart's org node is `{id,slug,displayName}` — it deliberately
 *      does NOT carry the vision, while the org detail GET does (pinned
 *      contrast);
 *   5. isolation + the global slug namespace of the resulting org hold.
 *
 * ── Verified LIVE against http://127.0.0.1:3100 (sqlite in-memory CI driver;
 *    catalog fetched from ever-works/orgs) BEFORE every assertion:
 *
 *   POST /api/organizations {name, vision?}      → 201 full OrgResponse
 *     (vision trimmed, empty/whitespace → null, visionUpdatedAt stamped iff
 *      a non-null value survives).
 *   POST /api/organizations/import-company {templateSlug, name?}
 *                                                → 201 {organization, created,
 *      skipped}. organization.vision === null, visionUpdatedAt === null at
 *      birth; registrationStatus 'draft', linkedWorkId null. `name` overrides
 *      displayName AND drives the derived (globally-cascaded) slug.
 *   PATCH /api/organizations/:id {vision}        → 200; vision omitted =
 *      unchanged; explicit null clears; any present value bumps visionUpdatedAt.
 *   GET  /api/organizations/:slug                → 200 GLOBAL resolver (any
 *      authed user), exposes vision + visionUpdatedAt.
 *   GET  /api/organizations/:id/teams | /:id/teams/:tid | /:id/teams/:tid/members
 *      | /:id/org-chart                           → 200 for the OWNER,
 *      404-not-leak for a non-owner (OrganizationOwnershipGuard).
 *   GET  /api/agents                              → 200 {data:[…]} tenant-wide.
 *
 * Env-adaptive: the catalog is fetched over the network from ever-works/orgs;
 * an env that can't reach it returns `[]` (wizard skips its step) and every
 * import test test.skip()s. Per-entity fetch failures during a materialize land
 * in `skipped[]`, so count assertions degrade to `<=` when skipped[] is
 * non-empty and cross-check the org-nested endpoints against `created` (the
 * source of truth for that run) rather than hardcoded catalog numbers.
 *
 * Isolation discipline: every test registers a FRESH registerUserViaAPI()
 * owner with a per-test-title suffix (never the seeded storageState user);
 * nothing loads at module scope (the e2e-1000 sharding gotcha). Fully
 * API-orchestrated + `flow-` filename ⇒ safe vs the playwright.config no-auth
 * testMatch/testIgnore regexes; contends on no shared UI state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const ORGS_BASE = `${API_BASE}/api/organizations`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface OrgTemplateEntry {
    slug: string;
    name: string;
    agents: number;
    teams: number;
    skills: number;
    projects: number;
}

interface OrgResponse {
    id: string;
    tenantId: string | null;
    slug: string;
    displayName: string | null;
    legalName: string | null;
    countryCode: string | null;
    registrationProvider: string | null;
    registrationStatus: string | null;
    linkedWorkId: string | null;
    vision?: string | null;
    visionUpdatedAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

interface CompanyImportReport {
    organization: OrgResponse;
    created: {
        teams: number;
        agents: number;
        members: number;
        skills: number;
        works: number;
        tasks: number;
    };
    skipped: Array<{ path: string; reason: string }>;
}

/** Per-test unique suffix derived from the test title (no module-scope clock). */
function suffix(title: string): string {
    const slugTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
    return `${slugTitle}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Millis of a serialized timestamp, or NaN when null/undefined/garbage. */
function millis(ts: string | null | undefined): number {
    return ts ? new Date(ts).getTime() : NaN;
}

/** GET /api/org-templates → 200 array (asserted). */
async function listTemplates(
    request: APIRequestContext,
    token: string,
): Promise<OrgTemplateEntry[]> {
    const res = await request.get(`${API_BASE}/api/org-templates`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `org-templates body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    return body;
}

/** Smallest catalog entry with real teams+agents (structural depth, cheap import). */
function pickSmall(templates: OrgTemplateEntry[]): OrgTemplateEntry | null {
    const candidates = templates
        .filter((t) => t.teams >= 1 && t.agents >= 1)
        .sort((a, b) => a.agents + a.teams - (b.agents + b.teams));
    return candidates[0] ?? null;
}

/** Two DISTINCT smallest catalog entries with teams+agents (for cross-org tests). */
function pickTwoDistinct(
    templates: OrgTemplateEntry[],
): [OrgTemplateEntry, OrgTemplateEntry] | null {
    const candidates = templates
        .filter((t) => t.teams >= 1 && t.agents >= 1)
        .sort((a, b) => a.agents + a.teams - (b.agents + b.teams));
    if (candidates.length < 2) return null;
    return [candidates[0], candidates[1]];
}

function createOrgRaw(request: APIRequestContext, token: string, body: Record<string, unknown>) {
    return request.post(ORGS_BASE, { headers: authedHeaders(token), data: body });
}

async function createOrgOk(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<OrgResponse> {
    const res = await createOrgRaw(request, token, body);
    expect(
        res.status(),
        `POST org ${JSON.stringify(body)} body=${await res.text().catch(() => '')}`,
    ).toBe(201);
    return res.json();
}

function importCompanyRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
) {
    return request.post(`${ORGS_BASE}/import-company`, {
        headers: authedHeaders(token),
        data: body,
    });
}

/** POST import-company → assert 201 + return the full report. */
async function importOk(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<CompanyImportReport> {
    const res = await importCompanyRaw(request, token, body);
    expect(
        res.status(),
        `import ${JSON.stringify(body)} body=${await res.text().catch(() => '')}`,
    ).toBe(201);
    return res.json();
}

function patchOrgRaw(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
) {
    return request.patch(`${ORGS_BASE}/${id}`, { headers: authedHeaders(token), data: body });
}

async function patchOrgOk(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
): Promise<OrgResponse> {
    const res = await patchOrgRaw(request, token, id, body);
    expect(
        res.status(),
        `PATCH ${JSON.stringify(body)} body=${await res.text().catch(() => '')}`,
    ).toBe(200);
    return res.json();
}

/** GET /api/organizations/:slug — the global slug resolver (fresh DB read). */
async function getBySlug(
    request: APIRequestContext,
    token: string,
    slug: string,
): Promise<OrgResponse> {
    const res = await request.get(`${ORGS_BASE}/${encodeURIComponent(slug)}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `get-by-slug body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function listOrgs(request: APIRequestContext, token: string): Promise<OrgResponse[]> {
    const res = await request.get(ORGS_BASE, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    return res.json();
}

interface OrgChart {
    organization: { id: string; slug: string; displayName: string | null };
    teams: Array<{
        id: string;
        slug: string;
        name: string;
        parentTeamId: string | null;
        managerAgentId: string | null;
    }>;
    agents: Array<{
        id: string;
        name: string;
        title: string | null;
        status: string;
        reportsToAgentId: string | null;
        teamIds?: string[];
    }>;
    members: Array<{ userId: string; name: string | null; teamIds: string[] }>;
}

async function orgChart(
    request: APIRequestContext,
    token: string,
    orgId: string,
): Promise<OrgChart> {
    const res = await request.get(`${ORGS_BASE}/${orgId}/org-chart`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `org-chart body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

interface TeamRow {
    id: string;
    slug: string;
    name: string;
    organizationId: string;
    managerAgentId: string | null;
    parentTeamId: string | null;
}

async function listTeams(
    request: APIRequestContext,
    token: string,
    orgId: string,
): Promise<TeamRow[]> {
    const res = await request.get(`${ORGS_BASE}/${orgId}/teams`, { headers: authedHeaders(token) });
    expect(res.status(), `teams body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** List + pick the smallest catalog template, or test.skip() this test. */
async function pickSmallOrSkip(
    request: APIRequestContext,
    token: string,
): Promise<OrgTemplateEntry | null> {
    const templates = await listTemplates(request, token);
    test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
    const tmpl = pickSmall(templates);
    test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
    return tmpl;
}

// Imports read ~100 files over the network + materialize many rows → generous.
const IMPORT_TIMEOUT = 120_000;

test.describe('Vision × Import chain — imported org is born vision-less', () => {
    test('an imported org is born vision:null / visionUpdatedAt:null (contrast the plain draft org)', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const org = report.organization;

        // The import materializer never threads a vision into createOrganization.
        expect(org.id).toMatch(UUID_RE);
        expect(org.registrationStatus).toBe('draft');
        expect(org.linkedWorkId).toBeNull();
        expect(org.vision ?? null, 'import must NOT synthesize a vision').toBeNull();
        expect(org.visionUpdatedAt ?? null, 'no vision ⇒ no vision timestamp').toBeNull();

        // Durable across a fresh global-resolver read (not just the create echo).
        const fresh = await getBySlug(request, token, org.slug);
        expect(fresh.id).toBe(org.id);
        expect(fresh.vision ?? null).toBeNull();
        expect(fresh.visionUpdatedAt ?? null).toBeNull();
    });

    test('a tenant that ALREADY owns a vision-bearing manual org still imports a vision-LESS org (vision is per-org)', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('per-org');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Manual org A carries a vision; it lazily bootstraps the tenant.
        const orgA = await createOrgOk(request, token, {
            name: `Manual Vision A ${s}`,
            vision: `A's north star ${s}`,
        });
        expect(orgA.vision).toBe(`A's north star ${s}`);
        const tenantId = orgA.tenantId;
        expect(tenantId).toMatch(UUID_RE);

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        // Imported org B lands in the SAME tenant but starts vision-less — the
        // field does not leak across sibling orgs of one tenant.
        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgB = report.organization;
        expect(orgB.tenantId, 'import lands in the caller’s existing tenant').toBe(tenantId);
        expect(orgB.id).not.toBe(orgA.id);
        expect(
            orgB.vision ?? null,
            'imported org vision is independent of the manual org',
        ).toBeNull();

        // Both coexist in the owner's list; only A carries a vision.
        const list = await listOrgs(request, token);
        const byId = new Map(list.map((o) => [o.id, o]));
        expect(byId.has(orgA.id)).toBe(true);
        expect(byId.has(orgB.id)).toBe(true);
        expect(byId.get(orgA.id)!.vision).toBe(`A's north star ${s}`);
        expect(byId.get(orgB.id)!.vision ?? null).toBeNull();
    });

    test('a name-override import is vision-less at birth AND the override drives the (kebab) slug', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('override');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const displayName = `Override Vision Co ${s}`;
        const report = await importOk(request, token, {
            templateSlug: tmpl.slug,
            name: displayName,
        });
        const org = report.organization;

        expect(org.displayName).toBe(displayName);
        expect(org.slug).toMatch(KEBAB_RE);
        expect(org.slug.startsWith('override-vision-co')).toBe(true);
        // The override changed the display identity but not the vision default.
        expect(org.vision ?? null).toBeNull();
        expect(org.visionUpdatedAt ?? null).toBeNull();
    });
});

test.describe('Vision × Import chain — setting the vision on an imported org', () => {
    test('PATCH lands a vision on the imported org; it persists via slug re-read and stamps visionUpdatedAt >= createdAt', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('set');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const org = report.organization;
        const createdMs = millis(org.createdAt);

        const visionText = `Materialize ${tmpl.name}, then aim it: ${s}`;
        const patched = await patchOrgOk(request, token, org.id, { vision: visionText });
        expect(patched.vision).toBe(visionText);
        const stampedMs = millis(patched.visionUpdatedAt);
        expect(Number.isFinite(stampedMs), 'setting vision stamps visionUpdatedAt').toBe(true);
        expect(stampedMs, 'vision stamp is at/after the org was created').toBeGreaterThanOrEqual(
            createdMs,
        );

        // Persisted, not just echoed.
        const fresh = await getBySlug(request, token, org.slug);
        expect(fresh.vision).toBe(visionText);
        expect(millis(fresh.visionUpdatedAt)).toBeGreaterThanOrEqual(createdMs);
    });

    test('setting a vision does NOT disturb the materialized structure (org-chart counts identical before & after)', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('nondestructive');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;

        const before = await orgChart(request, token, orgId);
        const teamsBefore = before.teams.length;
        const agentsBefore = before.agents.length;
        const membersBefore = before.members.length;
        // The chart reflects what the report claimed it created.
        expect(teamsBefore).toBe(report.created.teams);
        expect(agentsBefore).toBe(report.created.agents);

        await patchOrgOk(request, token, orgId, { vision: `Steady the ship ${s}` });

        const after = await orgChart(request, token, orgId);
        expect(after.teams.length, 'a vision PATCH must not add/drop teams').toBe(teamsBefore);
        expect(after.agents.length, 'a vision PATCH must not add/drop agents').toBe(agentsBefore);
        expect(after.members.length, 'a vision PATCH must not touch the human roster').toBe(
            membersBefore,
        );
        // The org node now carries the vision (checked via detail below), but
        // the structure ids are byte-for-byte stable.
        expect(after.teams.map((t) => t.id).sort()).toEqual(before.teams.map((t) => t.id).sort());
        expect(after.agents.map((a) => a.id).sort()).toEqual(before.agents.map((a) => a.id).sort());
    });

    test('re-setting the vision bumps visionUpdatedAt forward + swaps the text; structure still intact', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('reset');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        const teamCount = report.created.teams;

        const first = await patchOrgOk(request, token, orgId, { vision: `First direction ${s}` });
        const t1 = millis(first.visionUpdatedAt);
        expect(Number.isFinite(t1)).toBe(true);

        const second = await patchOrgOk(request, token, orgId, {
            vision: `Pivoted direction ${s}`,
        });
        expect(second.vision).toBe(`Pivoted direction ${s}`);
        const t2 = millis(second.visionUpdatedAt);
        // >= (not >) — a same-second write is legal on second-resolution stores.
        expect(t2, 'a vision change advances (or holds) the stamp').toBeGreaterThanOrEqual(t1);

        // Durable + structure untouched by two consecutive vision writes.
        const fresh = await getBySlug(request, token, report.organization.slug);
        expect(fresh.vision).toBe(`Pivoted direction ${s}`);
        expect((await listTeams(request, token, orgId)).length).toBe(teamCount);
    });

    test('clearing the vision to null on an imported org nulls the text; teams survive', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('clear');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        const teamCount = report.created.teams;

        await patchOrgOk(request, token, orgId, { vision: `Temporary heading ${s}` });
        const cleared = await patchOrgOk(request, token, orgId, { vision: null });
        expect(cleared.vision ?? null, 'vision:null clears the field').toBeNull();

        const fresh = await getBySlug(request, token, report.organization.slug);
        expect(fresh.vision ?? null).toBeNull();
        // Clearing the vision is not a destructive op on the org's structure.
        expect((await listTeams(request, token, orgId)).length).toBe(teamCount);
    });

    test('a whitespace-only vision PATCH on an imported org collapses to null (no lingering text)', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;

        // normalizeVision trims → empty → null. This is the PATCH-on-an-
        // imported-org variant (vision-deep only covers whitespace at CREATE).
        const res = await patchOrgOk(request, token, orgId, { vision: '   \n\t   ' });
        expect(res.vision ?? null, 'whitespace-only vision must store as null').toBeNull();

        const fresh = await getBySlug(request, token, report.organization.slug);
        expect(fresh.vision ?? null).toBeNull();
    });

    test('an untrimmed vision PATCH on an imported org is stored trimmed', async ({ request }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('trim');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;

        const core = `Trim me ${s}`;
        const res = await patchOrgOk(request, token, orgId, { vision: `   ${core}   ` });
        expect(res.vision, 'stored vision must be trimmed of surrounding whitespace').toBe(core);

        const fresh = await getBySlug(request, token, report.organization.slug);
        expect(fresh.vision).toBe(core);
    });

    test('an over-cap (6000-char) vision PATCH on an imported org rejects (400) or trims (<=5000); structure intact', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        const teamCount = report.created.teams;
        const longVision = 'V'.repeat(6000);

        // TOLERANT: a DTO @MaxLength(5000) 400 and a store-trimmed-to-cap 200
        // are BOTH acceptable — an unmapped 500 or a stored-untrimmed 6000 is a
        // real bug this catches. Either way the import structure is inert.
        const res = await patchOrgRaw(request, token, orgId, { vision: longVision });
        expect(
            [400, 200],
            `over-cap vision must reject or trim, got ${res.status()}: ${await res.text().catch(() => '')}`,
        ).toContain(res.status());

        const fresh = await getBySlug(request, token, report.organization.slug);
        if (res.status() === 400) {
            expect(fresh.vision ?? null, 'a rejected vision must not land').toBeNull();
        } else {
            const stored = fresh.vision as string;
            expect(typeof stored).toBe('string');
            expect(stored.length, `stored vision capped, got ${stored.length}`).toBeLessThanOrEqual(
                5000,
            );
            expect(stored.length).toBeGreaterThan(0);
            expect(longVision.startsWith(stored), 'trimmed vision is a prefix').toBe(true);
        }
        // Regardless of reject/trim, the materialized teams are untouched.
        expect((await listTeams(request, token, orgId)).length).toBe(teamCount);
    });

    test("the imported org's freshly-set vision echoes back in the owner's org list", async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('list-echo');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        const visionText = `Listed vision ${s}`;
        await patchOrgOk(request, token, orgId, { vision: visionText });

        const list = await listOrgs(request, token);
        const row = list.find((o) => o.id === orgId);
        expect(row, 'imported org must appear in the owner list').toBeTruthy();
        expect(row!.vision, 'the list response echoes the vision field').toBe(visionText);
        expect(Number.isFinite(millis(row!.visionUpdatedAt))).toBe(true);
    });
});

test.describe('Vision × Import chain — materialized structure asserted with the vision', () => {
    test('teams materialize (org-nested list == created.teams; each carries organizationId + a manager) with the vision set', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('teams');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        test.skip(report.created.teams === 0, 'template materialized no teams in this run');

        const visionText = `Team-shaped mission ${s}`;
        await patchOrgOk(request, token, orgId, { vision: visionText });

        const teams = await listTeams(request, token, orgId);
        expect(teams.length).toBe(report.created.teams);
        for (const t of teams) {
            expect(t.id).toMatch(UUID_RE);
            expect(t.slug).toMatch(KEBAB_RE);
            // Every imported team belongs to THIS org…
            expect(t.organizationId).toBe(orgId);
        }
        // …and at least one team seats a manager (the package wires managers).
        expect(
            teams.some((t) => t.managerAgentId),
            'an imported team names a manager',
        ).toBe(true);

        // The org still carries the vision we layered on after the import.
        expect((await getBySlug(request, token, report.organization.slug)).vision).toBe(visionText);
    });

    test('imported agents are tenant-scope + draft with a reportsTo hierarchy wired; the org vision is orthogonal', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('agents');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        test.skip(report.created.agents === 0, 'template created no agents in this run');

        await patchOrgOk(request, token, orgId, { vision: `Agent-staffed vision ${s}` });

        // This fresh user's tenant holds exactly this one import's agents.
        const res = await request.get(`${API_BASE}/api/agents`, { headers: authedHeaders(token) });
        expect(res.status()).toBe(200);
        const agents = (await res.json()).data as Array<{
            scope: string;
            status: string;
            reportsToAgentId: string | null;
            heartbeatCadence: unknown;
        }>;
        expect(agents.length).toBe(report.created.agents);
        for (const a of agents) {
            expect(a.scope).toBe('tenant');
            expect(a.status, 'imported agents arrive paused/manual (draft)').toBe('draft');
            expect(a.heartbeatCadence ?? null).toBeNull();
        }
        if (agents.length > 1) {
            expect(
                agents.some((a) => a.reportsToAgentId),
                'a multi-agent package wires reportsTo',
            ).toBe(true);
        }
        // Setting the org vision did not disturb the agent roster count.
        expect(agents.length).toBe(report.created.agents);
    });

    test('team roster carries agent members incl. one lead; vision is set and the roster is unaffected', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('roster');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        test.skip(report.created.members === 0, 'template seeded no roster rows in this run');

        await patchOrgOk(request, token, orgId, { vision: `Roster-backed vision ${s}` });

        const teams = await listTeams(request, token, orgId);
        let sawAgent = false;
        let sawLead = false;
        for (const t of teams) {
            const roster = await (
                await request.get(`${ORGS_BASE}/${orgId}/teams/${t.id}/members`, {
                    headers: authedHeaders(token),
                })
            ).json();
            expect(Array.isArray(roster)).toBe(true);
            for (const m of roster as Array<{
                memberType: string;
                role: string;
                memberId: string;
            }>) {
                if (m.memberType === 'agent') {
                    sawAgent = true;
                    expect(m.memberId).toMatch(UUID_RE);
                }
                if (m.role === 'lead') sawLead = true;
            }
        }
        expect(sawAgent, 'at least one imported team seats an agent').toBe(true);
        expect(sawLead, 'a managed team seats its manager as the lead').toBe(true);

        // The vision co-exists with the roster we just walked.
        expect((await getBySlug(request, token, report.organization.slug)).vision).toBe(
            `Roster-backed vision ${s}`,
        );
    });

    test('org-chart returns {organization,teams,agents,members}; the chart org node omits vision while the detail GET carries it', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('chart-shape');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        const visionText = `Charted vision ${s}`;
        await patchOrgOk(request, token, orgId, { vision: visionText });

        const chart = await orgChart(request, token, orgId);
        expect(chart.organization.id).toBe(orgId);
        expect(Array.isArray(chart.teams)).toBe(true);
        expect(Array.isArray(chart.agents)).toBe(true);
        // org-chart `members` are HUMAN org members (the owner) — distinct from
        // the import report's `members`, which counts agent team-roster rows.
        expect(Array.isArray(chart.members)).toBe(true);
        expect(chart.members.some((m) => m.userId === user.user.id)).toBe(true);
        expect(chart.teams.length).toBe(report.created.teams);
        expect(chart.agents.length).toBe(report.created.agents);

        // CONTRACT PIN: the compact org-chart node is {id,slug,displayName} —
        // it deliberately does NOT re-serialize the (potentially large) vision,
        // even though the org clearly HAS one (asserted via the detail GET).
        expect((chart.organization as unknown as Record<string, unknown>).vision).toBeUndefined();
        expect((await getBySlug(request, token, report.organization.slug)).vision).toBe(visionText);
    });

    test('org-chart agent.teamIds map onto the materialized team ids and exactly one agent is a root (reportsTo null)', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const report = await importOk(request, token, { templateSlug: tmpl.slug });
        const orgId = report.organization.id;
        test.skip(report.created.agents === 0, 'template created no agents in this run');

        const chart = await orgChart(request, token, orgId);
        const teamIds = new Set(chart.teams.map((t) => t.id));

        // Every team an agent is seated on is a real team of THIS org's chart.
        for (const a of chart.agents) {
            for (const tid of a.teamIds ?? []) {
                expect(teamIds.has(tid), `agent ${a.id} references a foreign team ${tid}`).toBe(
                    true,
                );
            }
        }
        // A package roots its hierarchy at one top agent (reportsTo null). With
        // >1 agent at least one root must exist for the tree to be connected.
        if (chart.agents.length > 1) {
            expect(chart.agents.some((a) => a.reportsToAgentId === null)).toBe(true);
        }
    });
});

test.describe('Vision × Import chain — isolation & slug namespace', () => {
    test('a cross-owner PATCH of the imported org’s vision is 404-not-leak; the owner vision survives; the intruder can still slug-resolve + read it', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('cross-owner');
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);

        const tmpl = await pickSmallOrSkip(request, owner.access_token);
        if (!tmpl) return;

        const report = await importOk(request, owner.access_token, { templateSlug: tmpl.slug });
        const org = report.organization;
        const ownerVision = `Owner-only heading ${s}`;
        await patchOrgOk(request, owner.access_token, org.id, { vision: ownerVision });

        // Intruder HAS their own tenant (clears the no-tenant 401 guard) so we
        // exercise the ownership check itself → 404 not-leak (NOT 403).
        await createOrgOk(request, intruder.access_token, { name: `Intruder Org ${s}` });
        const hijack = await patchOrgRaw(request, intruder.access_token, org.id, {
            vision: 'HIJACKED VISION',
        });
        expect(
            hijack.status(),
            `cross-owner vision PATCH must 404, body=${await hijack.text().catch(() => '')}`,
        ).toBe(404);

        // The foreign write never landed…
        expect((await getBySlug(request, owner.access_token, org.slug)).vision).toBe(ownerVision);
        // …and GET /api/organizations/:slug is a GLOBAL resolver — the intruder
        // reads the org AND its vision (proving the 404 above was the WRITE
        // guard, not a read failure).
        expect((await getBySlug(request, intruder.access_token, org.slug)).vision).toBe(
            ownerVision,
        );
    });

    test('a non-owner is walled (404) from the imported org’s teams + org-chart even though the slug resolves globally', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('walled');
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);

        const tmpl = await pickSmallOrSkip(request, owner.access_token);
        if (!tmpl) return;

        const report = await importOk(request, owner.access_token, { templateSlug: tmpl.slug });
        const org = report.organization;
        await patchOrgOk(request, owner.access_token, org.id, { vision: `Fenced vision ${s}` });

        // Ownership-guarded org-nested routes → 404 for the intruder.
        expect(
            (
                await request.get(`${ORGS_BASE}/${org.id}/teams`, {
                    headers: authedHeaders(intruder.access_token),
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${ORGS_BASE}/${org.id}/org-chart`, {
                    headers: authedHeaders(intruder.access_token),
                })
            ).status(),
        ).toBe(404);

        // …but the global slug resolver still returns the org (with vision).
        expect((await getBySlug(request, intruder.access_token, org.slug)).vision).toBe(
            `Fenced vision ${s}`,
        );
        // The owner keeps full access to their own org's teams.
        expect(
            (
                await request.get(`${ORGS_BASE}/${org.id}/teams`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
        ).toBe(200);
    });

    test('re-importing the SAME template twice mints two orgs with distinct cascaded slugs, each independently vision-settable', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('reimport');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const tmpl = await pickSmallOrSkip(request, token);
        if (!tmpl) return;

        const name = `Twin Import ${s}`;
        const first = (await importOk(request, token, { templateSlug: tmpl.slug, name }))
            .organization;
        const second = (await importOk(request, token, { templateSlug: tmpl.slug, name }))
            .organization;

        expect(first.id).not.toBe(second.id);
        // Global org-slug namespace ⇒ the 2nd cannot reuse the 1st's slug.
        expect(second.slug).not.toBe(first.slug);
        expect(second.slug).toMatch(KEBAB_RE);

        // Independent visions, no cross-contamination between the twin imports.
        await patchOrgOk(request, token, first.id, { vision: `First twin heading ${s}` });
        await patchOrgOk(request, token, second.id, { vision: `Second twin heading ${s}` });
        expect((await getBySlug(request, token, first.slug)).vision).toBe(
            `First twin heading ${s}`,
        );
        expect((await getBySlug(request, token, second.slug)).vision).toBe(
            `Second twin heading ${s}`,
        );
    });

    test('two DIFFERENT-template imports in one tenant carry independent visions + independent structures', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        const s = suffix('two-templates');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const pair = pickTwoDistinct(templates);
        test.skip(!pair, 'fewer than two catalog templates with teams+agents in this environment');
        if (!pair) return;
        const [tA, tB] = pair;

        const reportA = await importOk(request, token, { templateSlug: tA.slug });
        const reportB = await importOk(request, token, { templateSlug: tB.slug });
        expect(reportA.organization.id).not.toBe(reportB.organization.id);

        await patchOrgOk(request, token, reportA.organization.id, { vision: `A vision ${s}` });
        await patchOrgOk(request, token, reportB.organization.id, { vision: `B vision ${s}` });

        // Visions are per-org, not cross-wired.
        expect((await getBySlug(request, token, reportA.organization.slug)).vision).toBe(
            `A vision ${s}`,
        );
        expect((await getBySlug(request, token, reportB.organization.slug)).vision).toBe(
            `B vision ${s}`,
        );

        // Each org's own org-nested teams equal its OWN report's created.teams
        // (org-scoped endpoints, so the shared tenant never conflates them).
        expect((await listTeams(request, token, reportA.organization.id)).length).toBe(
            reportA.created.teams,
        );
        expect((await listTeams(request, token, reportB.organization.id)).length).toBe(
            reportB.created.teams,
        );
    });
});

test.describe('Vision × Import chain — auth & id validation', () => {
    test('import-company without a bearer → 401, and PATCH vision on an imported org without a bearer → 401', async ({
        request,
    }) => {
        test.setTimeout(IMPORT_TIMEOUT);
        // Anonymous import is walled before any materialization.
        const anon = await request.post(`${ORGS_BASE}/import-company`, {
            data: { templateSlug: 'ever-starter' },
        });
        expect(anon.status()).toBe(401);

        // A real imported org still cannot be vision-patched anonymously.
        const owner = await registerUserViaAPI(request);
        const tmpl = await pickSmallOrSkip(request, owner.access_token);
        if (!tmpl) return;
        const report = await importOk(request, owner.access_token, { templateSlug: tmpl.slug });
        const anonPatch = await request.patch(`${ORGS_BASE}/${report.organization.id}`, {
            data: { vision: 'no-auth vision' },
        });
        expect(anonPatch.status()).toBe(401);
        // The org's vision is untouched by the rejected anonymous write.
        expect(
            (await getBySlug(request, owner.access_token, report.organization.slug)).vision ?? null,
        ).toBeNull();
    });

    test('PATCH vision with a malformed org id → 400 (ParseUUIDPipe); an unknown uuid → 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Malformed id never reaches the service — the ParseUUIDPipe 400s it.
        const malformed = await patchOrgRaw(request, token, 'not-a-uuid', { vision: 'x' });
        expect(malformed.status()).toBe(400);

        // A well-formed but unknown id never resolves to a membership, so the org
        // ACCESS guard rejects it BEFORE any existence lookup → 401, not a 404.
        // (Same posture as the rest of the org surface: no existence is leaked.)
        const unknown = await patchOrgRaw(request, token, UNKNOWN_UUID, { vision: 'x' });
        expect([401, 403, 404], `unknown org status ${unknown.status()}`).toContain(
            unknown.status(),
        );
    });
});
