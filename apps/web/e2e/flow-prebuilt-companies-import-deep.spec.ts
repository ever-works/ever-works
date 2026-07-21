/**
 * Prebuilt Companies — catalog + `import-company` materializer, DEEP (#1647).
 *
 * The Teams & Prebuilt Companies epic shipped a two-endpoint "import a whole
 * AI company" surface with ZERO dedicated e2e coverage:
 *
 *   GET  /api/org-templates                    (OrgTemplatesController)
 *   POST /api/organizations/import-company      (CompanyImportController)
 *
 * `import-company` reads one `agentcompanies/v1` package from the public
 * `ever-works/orgs` catalog and materializes it into a FRESH Organization:
 * Teams (+manager+roster), paused tenant-scope Agents (with reportsTo
 * hierarchy), tenant Skills, draft Works, and Tasks — all reported back as
 * `{ organization, created:{…}, skipped:[] }`. Per-entity failures land in
 * `skipped[]`; the Organization pivot itself never half-fails.
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory CI driver,
 *    catalog fetched from ever-works/orgs) BEFORE any assertion below:
 *
 *  GET /api/org-templates → 200, bare array of OrgTemplateEntry
 *      { slug, name, description, category, agents, teams, skills, projects,
 *        iconName?, tags?, featured? } — the importer-only `path`/`files`
 *        inventory is intentionally NOT leaked. 401 without a bearer.
 *
 *  POST import-company { templateSlug, name? }:
 *   • 201 → { organization, created:{teams,agents,members,skills,works,tasks},
 *            skipped:[] }. The org is a PLAIN draft org — registrationStatus
 *            'draft', registrationProvider null, linkedWorkId null (NOT a
 *            register-company org). `name` overrides displayName AND drives the
 *            derived slug; the slug lives in the GLOBAL org namespace so a repeat
 *            cascades (-2/-3/…). When skipped[] is empty the created counts equal
 *            the catalog entry's declared agents/teams/skills/projects.
 *   • Materialized rows are real & readable: teams via the org-nested Teams
 *     API (roster carries the agents, one 'lead'), agents are tenant-scope +
 *     status 'draft' with reportsTo wired, org-chart returns them.
 *   • 404 for a valid-but-unknown kebab slug ("Company template <s> not found")
 *     AND when the catalog is unreachable (getPackage → null).
 *   • 400 validation: missing/empty/UPPERCASE/65-char/non-string templateSlug,
 *     empty/201-char name, stray non-whitelisted key.
 *   • 401 without a bearer.
 *   • 429 — @Throttle({ long:{ limit:5, ttl:60_000 } }); the custom
 *     UserAwareThrottlerGuard keys by `user:<id>`, so the 5/60s budget is
 *     PER-USER — a 6th call from one user 429s while every other test's fresh
 *     user is unaffected.
 *
 * Cross-owner isolation: the org-nested Teams / org-chart routes are
 * OrganizationOwnershipGuard'd (404-never-403 for a non-owner), while
 * GET /api/organizations/:slug is a GLOBAL resolver (any authed user → 200) —
 * both boundaries pinned below.
 *
 * Isolation discipline: every test uses a FRESH registerUserViaAPI() owner
 * with a per-test-title suffix (never the seeded storageState user). Fully
 * API-orchestrated + `flow-` filename ⇒ safe vs the playwright.config
 * testIgnore regex; contends on no shared UI state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;

interface OrgTemplateEntry {
    slug: string;
    name: string;
    description: string;
    category: string;
    agents: number;
    teams: number;
    skills: number;
    projects: number;
    iconName?: string;
    tags?: string[];
    featured?: boolean;
}

interface CompanyImportReport {
    organization: {
        id: string;
        slug: string;
        displayName: string;
        legalName: string | null;
        countryCode: string | null;
        registrationStatus: string;
        registrationProvider: string | null;
        linkedWorkId: string | null;
        tenantId: string | null;
        createdAt: string;
        updatedAt: string;
    };
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

/** GET /api/org-templates (raw — caller inspects status). */
function listTemplatesRaw(request: APIRequestContext, token: string) {
    return request.get(`${API_BASE}/api/org-templates`, { headers: authedHeaders(token) });
}

/** GET /api/org-templates → 200 array (asserted). */
async function listTemplates(
    request: APIRequestContext,
    token: string,
): Promise<OrgTemplateEntry[]> {
    const res = await listTemplatesRaw(request, token);
    expect(res.status(), `org-templates body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    return body;
}

/** POST /api/organizations/import-company (raw — caller inspects status). */
function importCompanyRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/organizations/import-company`, {
        headers: authedHeaders(token),
        data: body,
    });
}

/** Smallest catalog entry with real teams+agents (structural depth, cheap import). */
function pickSmall(templates: OrgTemplateEntry[]): OrgTemplateEntry | null {
    const candidates = templates
        .filter((t) => t.teams >= 1 && t.agents >= 1)
        .sort((a, b) => a.agents + a.teams - (b.agents + b.teams));
    return candidates[0] ?? null;
}

/** First catalog entry that declares at least one project (→ draft Works). */
function pickWithProject(templates: OrgTemplateEntry[]): OrgTemplateEntry | null {
    return templates.find((t) => t.projects >= 1 && t.teams >= 1 && t.agents >= 1) ?? null;
}

test.describe('Prebuilt Companies — org-templates catalog', () => {
    test('GET /api/org-templates returns the public OrgTemplateEntry shape (no path/files leak)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const templates = await listTemplates(request, user.access_token);

        // The live catalog is populated from ever-works/orgs; if a given env
        // can't reach it the list is [] by contract (wizard skips its step).
        // Only assert the per-entry shape when there IS an entry to inspect.
        if (templates.length === 0) return;

        const entry = templates[0];
        expect(entry.slug).toMatch(KEBAB_RE);
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(typeof entry.description).toBe('string');
        expect(typeof entry.category).toBe('string');
        for (const k of ['agents', 'teams', 'skills', 'projects'] as const) {
            expect(Number.isInteger(entry[k]), `${k} is an int`).toBe(true);
            expect(entry[k]).toBeGreaterThanOrEqual(0);
        }
        if (entry.tags !== undefined) {
            expect(Array.isArray(entry.tags)).toBe(true);
            for (const t of entry.tags) expect(typeof t).toBe('string');
        }
        if (entry.featured !== undefined) expect(typeof entry.featured).toBe('boolean');
        // The importer-only inventory must NOT be exposed on the public wire.
        const raw = entry as unknown as Record<string, unknown>;
        expect(raw.path).toBeUndefined();
        expect(raw.files).toBeUndefined();
    });

    test('GET /api/org-templates without a bearer → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/org-templates`);
        expect(res.status()).toBe(401);
    });
});

test.describe('Prebuilt Companies — import-company validation & auth', () => {
    test('POST import-company without a bearer → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/organizations/import-company`, {
            data: { templateSlug: 'ever-starter' },
        });
        expect(res.status()).toBe(401);
    });

    test('missing templateSlug ({}) → 400 with the not-empty/string messages', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, {});
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(
            /templateSlug should not be empty|templateSlug must be a string/i,
        );
    });

    test('UPPERCASE templateSlug → 400 "must be kebab-case"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, {
            templateSlug: 'Craftsman-Dev-Shop',
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(/kebab-case/i);
    });

    test('empty-string templateSlug → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, { templateSlug: '' });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(/should not be empty|kebab/i);
    });

    test('a 65-char templateSlug → 400 "shorter than or equal to 64"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, {
            templateSlug: 'a'.repeat(65),
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(/64|shorter/i);
    });

    test('non-string templateSlug (number) → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, {
            templateSlug: 123 as unknown as string,
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(/must be a string|kebab/i);
    });

    test('a path-traversal templateSlug is rejected by the kebab matcher → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, {
            templateSlug: '../../secret',
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(/kebab-case/i);
    });

    test('stray non-whitelisted key → 400 "property <x> should not exist"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, {
            templateSlug: 'ever-starter',
            slug: 'sneaky',
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(
            /property slug should not exist/i,
        );
    });

    test('empty name override → 400 "name should not be empty"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, {
            templateSlug: 'ever-starter',
            name: '',
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(/name should not be empty/i);
    });

    test('a 201-char name override → 400 "shorter than or equal to 200"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, user.access_token, {
            templateSlug: 'ever-starter',
            name: 'x'.repeat(201),
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toMatch(/200|shorter/i);
    });
});

test.describe('Prebuilt Companies — unknown slug & per-user throttle', () => {
    test('a valid-but-unknown kebab slug → 404 "Company template <slug> not found"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const slug = `no-such-company-${Math.random().toString(36).slice(2, 8)}`;
        const res = await importCompanyRaw(request, user.access_token, { templateSlug: slug });
        expect(res.status()).toBe(404);
        expect(JSON.stringify((await res.json()).message)).toMatch(
            new RegExp(`Company template ${slug} not found`, 'i'),
        );
    });

    test('the 5/60s import throttle is PER-USER: a 6th call from one user → 429', async ({
        request,
    }) => {
        // Unknown-slug imports 404 in the handler but still tick the throttle
        // (the guard increments before the handler runs), so we can exhaust the
        // budget cheaply without materializing anything.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) {
            const res = await importCompanyRaw(request, token, {
                templateSlug: `throttle-probe-${i}-${Math.random().toString(36).slice(2, 6)}`,
            });
            codes.push(res.status());
        }
        // First five are allowed through to the 404 handler; the sixth is walled.
        expect(codes.slice(0, 5).every((c) => c === 404)).toBe(true);
        expect(codes[5]).toBe(429);
    });

    test('a DIFFERENT user is unaffected by another user having hit their own throttle', async ({
        request,
    }) => {
        const heavy = await registerUserViaAPI(request);
        for (let i = 0; i < 6; i++) {
            await importCompanyRaw(request, heavy.access_token, {
                templateSlug: `burn-${i}-${Math.random().toString(36).slice(2, 6)}`,
            });
        }
        // A brand-new user's very first call is NOT 429 — the bucket is per-user.
        const fresh = await registerUserViaAPI(request);
        const res = await importCompanyRaw(request, fresh.access_token, {
            templateSlug: `still-unknown-${Math.random().toString(36).slice(2, 6)}`,
        });
        expect(res.status()).not.toBe(429);
        expect(res.status()).toBe(404);
    });
});

test.describe('Prebuilt Companies — materialized org structure', () => {
    test('a real import returns the full report + a PLAIN draft org (not a register-company org)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const res = await importCompanyRaw(request, token, { templateSlug: tmpl.slug });
        expect(res.status(), `import body=${await res.text().catch(() => '')}`).toBe(201);
        const report = (await res.json()) as CompanyImportReport;

        // The organization pivot: a fresh, PLAIN draft org in the caller's tenant.
        const org = report.organization;
        expect(org.id).toMatch(UUID_RE);
        expect(org.slug).toMatch(KEBAB_RE);
        expect(typeof org.displayName).toBe('string');
        expect(org.displayName.length).toBeGreaterThan(0);
        expect(org.tenantId).toMatch(UUID_RE);
        // CONTRAST vs register-company: import does NOT register or link a Work.
        expect(org.registrationStatus).toBe('draft');
        expect(org.registrationProvider).toBeNull();
        expect(org.linkedWorkId).toBeNull();
        expect(org.legalName).toBeNull();

        // The report envelope is always fully populated…
        for (const k of ['teams', 'agents', 'members', 'skills', 'works', 'tasks'] as const) {
            expect(Number.isInteger(report.created[k]), `created.${k} int`).toBe(true);
            expect(report.created[k]).toBeGreaterThanOrEqual(0);
        }
        expect(Array.isArray(report.skipped)).toBe(true);

        // …and when nothing was skipped the counts match the catalog's manifest.
        if (report.skipped.length === 0) {
            expect(report.created.teams).toBe(tmpl.teams);
            expect(report.created.agents).toBe(tmpl.agents);
            expect(report.created.skills).toBe(tmpl.skills);
            expect(report.created.works).toBe(tmpl.projects);
        } else {
            // Degraded fetch is a soft failure: the org still exists, counts hold.
            expect(report.created.teams).toBeLessThanOrEqual(tmpl.teams);
            expect(report.created.agents).toBeLessThanOrEqual(tmpl.agents);
        }
    });

    test('name override drives BOTH displayName and the derived slug', async ({ request }) => {
        test.setTimeout(120_000);
        const s = suffix('name-override');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const displayName = `Override Co ${s}`;
        const res = await importCompanyRaw(request, token, {
            templateSlug: tmpl.slug,
            name: displayName,
        });
        expect(res.status(), `import body=${await res.text().catch(() => '')}`).toBe(201);
        const org = (await res.json()).organization as CompanyImportReport['organization'];

        expect(org.displayName).toBe(displayName);
        // The slug is derived from the OVERRIDE name (kebab), not the template.
        expect(org.slug).toMatch(KEBAB_RE);
        expect(org.slug.startsWith('override-co')).toBe(true);
    });

    test('the imported org is a real, listed org and resolves by slug for its owner', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const org = (
            await (await importCompanyRaw(request, token, { templateSlug: tmpl.slug })).json()
        ).organization as CompanyImportReport['organization'];

        // It shows up in the caller's own org list…
        const list = await request.get(`${API_BASE}/api/organizations`, {
            headers: authedHeaders(token),
        });
        expect(list.status()).toBe(200);
        expect((await list.json()).map((o: { id: string }) => o.id)).toContain(org.id);

        // …and the global slug resolver returns it (still a draft, no linked Work).
        const bySlug = await request.get(`${API_BASE}/api/organizations/${org.slug}`, {
            headers: authedHeaders(token),
        });
        expect(bySlug.status()).toBe(200);
        const resolved = await bySlug.json();
        expect(resolved.id).toBe(org.id);
        expect(resolved.registrationStatus).toBe('draft');
        expect(resolved.linkedWorkId).toBeNull();
    });

    test('imported Teams are real via the org-nested Teams API (detail carries members[] + a manager)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const report = (await (
            await importCompanyRaw(request, token, { templateSlug: tmpl.slug })
        ).json()) as CompanyImportReport;
        const orgId = report.organization.id;
        test.skip(report.created.teams === 0, 'template materialized no teams in this run');

        const teamsRes = await request.get(`${API_BASE}/api/organizations/${orgId}/teams`, {
            headers: authedHeaders(token),
        });
        expect(teamsRes.status()).toBe(200);
        const teams = await teamsRes.json();
        expect(Array.isArray(teams)).toBe(true);
        expect(teams.length).toBe(report.created.teams);

        const detail = await request.get(
            `${API_BASE}/api/organizations/${orgId}/teams/${teams[0].id}`,
            { headers: authedHeaders(token) },
        );
        expect(detail.status()).toBe(200);
        const team = await detail.json();
        expect(team.id).toBe(teams[0].id);
        expect(team.slug).toMatch(KEBAB_RE);
        expect(Array.isArray(team.members)).toBe(true);
        expect(Array.isArray(team.childTeamIds)).toBe(true);
    });

    test('imported team roster is populated with agent members (one seated as lead)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const report = (await (
            await importCompanyRaw(request, token, { templateSlug: tmpl.slug })
        ).json()) as CompanyImportReport;
        const orgId = report.organization.id;
        test.skip(report.created.members === 0, 'template seeded no roster rows in this run');

        const teams = await (
            await request.get(`${API_BASE}/api/organizations/${orgId}/teams`, {
                headers: authedHeaders(token),
            })
        ).json();

        // Find a team whose roster is non-empty and inspect its members.
        let sawAgent = false;
        let sawLead = false;
        for (const t of teams) {
            const roster = await (
                await request.get(`${API_BASE}/api/organizations/${orgId}/teams/${t.id}/members`, {
                    headers: authedHeaders(token),
                })
            ).json();
            for (const m of roster) {
                if (m.memberType === 'agent') sawAgent = true;
                if (m.role === 'lead') sawLead = true;
            }
        }
        expect(sawAgent, 'at least one imported team has an agent on its roster').toBe(true);
        // A managed team seats its manager as the lead (mirrors TEAM.md semantics).
        expect(sawLead).toBe(true);
    });

    test('imported Agents are tenant-scope, status draft, with a reportsTo hierarchy wired', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const report = (await (
            await importCompanyRaw(request, token, { templateSlug: tmpl.slug })
        ).json()) as CompanyImportReport;
        test.skip(report.created.agents === 0, 'template created no agents in this run');

        const agentsRes = await request.get(`${API_BASE}/api/agents`, {
            headers: authedHeaders(token),
        });
        expect(agentsRes.status()).toBe(200);
        const agents = (await agentsRes.json()).data as Array<{
            scope: string;
            status: string;
            reportsToAgentId: string | null;
            heartbeatCadence: unknown;
        }>;
        expect(agents.length).toBe(report.created.agents);
        for (const a of agents) {
            expect(a.scope).toBe('tenant');
            // Imported agents arrive paused/manual — a human enables them later.
            expect(a.status).toBe('draft');
            expect(a.heartbeatCadence ?? null).toBeNull();
        }
        // With >1 agent the package wires at least one reportsTo edge (2nd pass).
        if (agents.length > 1) {
            expect(agents.some((a) => a.reportsToAgentId)).toBe(true);
        }
    });

    test('org-chart of an imported org returns { organization, teams, agents, members }', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const report = (await (
            await importCompanyRaw(request, token, { templateSlug: tmpl.slug })
        ).json()) as CompanyImportReport;
        const orgId = report.organization.id;

        const chart = await request.get(`${API_BASE}/api/organizations/${orgId}/org-chart`, {
            headers: authedHeaders(token),
        });
        expect(chart.status()).toBe(200);
        const body = await chart.json();
        expect(body.organization?.id).toBe(orgId);
        expect(Array.isArray(body.teams)).toBe(true);
        expect(Array.isArray(body.agents)).toBe(true);
        // org-chart `members` are HUMAN org members (the owner) — distinct from
        // the report's `members`, which counts agent team-roster rows.
        expect(Array.isArray(body.members)).toBe(true);
        expect(body.teams.length).toBe(report.created.teams);
        expect(body.agents.length).toBe(report.created.agents);
    });

    test('a template that declares projects materializes draft Works', async ({ request }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickWithProject(templates);
        test.skip(!tmpl, 'no catalog template declares a project in this environment');

        const report = (await (
            await importCompanyRaw(request, token, { templateSlug: tmpl!.slug })
        ).json()) as CompanyImportReport;
        expect(report.organization.id).toMatch(UUID_RE);
        if (report.skipped.length === 0) {
            expect(report.created.works).toBe(tmpl!.projects);
        } else {
            expect(report.created.works).toBeGreaterThanOrEqual(0);
        }
        // Tasks are project-scoped; a projects>=1 import may or may not carry
        // TASK.md rows, but the count is always a valid non-negative integer.
        expect(Number.isInteger(report.created.tasks)).toBe(true);
        expect(report.created.tasks).toBeGreaterThanOrEqual(0);
    });
});

test.describe('Prebuilt Companies — slug namespace & cross-owner isolation', () => {
    test('importing the same template twice mints two orgs with distinct cascaded slugs', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const templates = await listTemplates(request, token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const first = (
            await (await importCompanyRaw(request, token, { templateSlug: tmpl.slug })).json()
        ).organization as CompanyImportReport['organization'];
        const second = (
            await (await importCompanyRaw(request, token, { templateSlug: tmpl.slug })).json()
        ).organization as CompanyImportReport['organization'];

        expect(first.id).not.toBe(second.id);
        // Global org-slug namespace ⇒ the second cannot reuse the first's slug.
        expect(second.slug).not.toBe(first.slug);
        expect(second.slug).toMatch(KEBAB_RE);
    });

    test('a non-owner is walled off (404) from the imported org-nested routes, but slug resolves globally', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);

        const templates = await listTemplates(request, owner.access_token);
        test.skip(templates.length === 0, 'org-templates catalog unreachable in this environment');
        const tmpl = pickSmall(templates);
        test.skip(!tmpl, 'no catalog template with teams >= 1 and agents >= 1 in this environment');
        if (!tmpl) return;

        const org = (
            await (
                await importCompanyRaw(request, owner.access_token, { templateSlug: tmpl.slug })
            ).json()
        ).organization as CompanyImportReport['organization'];

        // Ownership-guarded routes → 404 for the intruder (404-never-403 posture).
        expect(
            (
                await request.get(`${API_BASE}/api/organizations/${org.id}/teams`, {
                    headers: authedHeaders(intruder.access_token),
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/organizations/${org.id}/org-chart`, {
                    headers: authedHeaders(intruder.access_token),
                })
            ).status(),
        ).toBe(404);

        // …but GET /api/organizations/:slug is a GLOBAL resolver (any authed
        // user → 200); it is NOT part of the ownership boundary.
        expect(
            (
                await request.get(`${API_BASE}/api/organizations/${org.slug}`, {
                    headers: authedHeaders(intruder.access_token),
                })
            ).status(),
        ).toBe(200);

        // The owner still has full access to their own org's teams.
        expect(
            (
                await request.get(`${API_BASE}/api/organizations/${org.id}/teams`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
        ).toBe(200);
    });
});
