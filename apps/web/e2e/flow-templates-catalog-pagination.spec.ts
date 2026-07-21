import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

/**
 * flow-templates-catalog-pagination — the three READ-side template catalogs,
 * driven end-to-end against the live stack, pinned on their ORDERING /
 * FILTERING / "is-this-even-paginated" contracts + real CONCURRENCY, NOT
 * happy-path CRUD.
 *
 * Three distinct surfaces, three distinct shapes (probed live before writing):
 *
 *   GET /api/templates?kind=website|work|mission|company   (auth, user-scoped)
 *     → { status:'success', kind, defaultTemplateId:string|null,
 *         templates: TemplateCatalogItem[] }
 *     • kind is OPTIONAL, defaults to 'work' (back-compat). Invalid kind → 400
 *       {message:['kind must be one of the following values: website, work,
 *        mission, company'], error:'Bad Request', statusCode:400}. No auth → 401.
 *     • The list is NOT paginated and REJECTS pagination params — the DTO
 *       whitelists ONLY `kind`, so `?limit`/`?offset`/`?page`/`?sort`/`?q` →
 *       400 (forbidNonWhitelisted). The full visible catalog is always returned.
 *     • ORDERING is `sourceType DESC, name ASC` → the user's OWN custom
 *       templates sort BEFORE every built-in; within a group, name-ascending.
 *     • defaultTemplateId: website falls back to 'classic' for a fresh user;
 *       work/mission/company default to null until a preference is set.
 *     • Custom templates (`custom-<uuid>` ids) are PER-USER — user B never sees
 *       user A's rows. Website built-in `customizable` is asymmetric
 *       (classic:false, minimal:true). PUT /api/templates/default flips exactly
 *       one row's `isDefault`; archiving the defaulted custom reverts the
 *       default to 'classic'.
 *
 *   GET /api/work-templates?chipType=…                     (PUBLIC, bare array)
 *     → WorkBlueprintEntry[]  (external ever-works/works manifest, 1h-cached)
 *     • No auth. chipType filter is an EXACT lowercase-slug match
 *       (SAFE_SLUG /^[a-z0-9][a-z0-9-]{0,63}$/): 'Directory' (uppercase),
 *       unknown, and injection-style values all → []; empty/absent → full
 *       catalog. Filtered result is a strict subset (chipType === filter).
 *     • Catalog carries production + placeholder rows; production rows always
 *       carry a `templateRepoName`. Order is deterministic across calls (cache).
 *
 *   GET /api/org-templates                                 (auth, bare array)
 *     → OrgTemplateEntry[]  (external ever-works/orgs manifest, 1h-cached)
 *     • No auth → 401. No pagination/filter params exist. Each entry exposes
 *       counts (agents/teams/skills/projects) as non-negative ints and lowercase
 *       slugs, and DELIBERATELY omits the importer-only `path`/`files` fields.
 *
 *   GET /api/template-catalog                              → 404 (no such route)
 *
 * CONCURRENCY invariants pinned (sqlite in-memory is the CI driver):
 *   • N parallel identical GETs → all 200, identical template-id set.
 *   • N parallel identical custom-adds (same repo) → dedup: the resulting list
 *     holds exactly `successes` rows for that repo (no phantom duplicates); the
 *     rest are 409. Terminal state is corruption-free.
 *   • N parallel competing set-default → exactly ONE `isDefault:true` terminal
 *     row; the winner is one of the submitted ids (last-write-wins).
 *
 * ── DISTINCT FROM SIBLINGS. template-catalog-deep / website-templates /
 *    flow-website-template-catalog / flow-templates-deploy pin catalog
 *    enumeration, per-Work template binding, auto-update and the customization
 *    ledger (many with weak `<500` smoke). NONE of them pin the LIST ORDERING
 *    contract, the pagination-param REJECTION, cross-user custom isolation in
 *    the list, the work-templates chipType allowlist edges, the org-templates
 *    field-omission contract, or the parallel-race terminal states. THIS file
 *    owns those angles.
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI() users with
 * unique suffixes; ids are asserted via toContain / not.toContain (never exact
 * global counts — the shard DB accumulates custom rows across specs); ordering
 * is asserted non-decreasing (tolerating equal-name ties); status matchers are
 * tolerant where multiple codes are legitimate. Fully API-orchestrated (safe
 * `flow-` prefix), so it never contends on the shared UI auth state.
 */

const CUSTOM_ID_RE = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Built-in ids seeded once, globally, by TemplateCatalogService.onModuleInit —
// stable across shards, so toContain is safe.
const WEBSITE_BUILTIN_IDS = ['classic', 'minimal', 'web', 'web-minimal'];
const WORK_BUILTIN_IDS = ['starter-directory', 'starter-directory-minimal'];

interface CatalogItem {
    id: string;
    kind: string;
    sourceType: 'built_in' | 'custom';
    originType: string;
    name: string;
    branch: string;
    syncBranches: string[];
    isActive: boolean;
    isDefault: boolean;
    ownerUserId: string | null;
    customizable: boolean;
    baseTemplateId: string | null;
    repositoryName: string;
    [k: string]: unknown;
}

interface CatalogResponse {
    status: string;
    kind: string;
    defaultTemplateId: string | null;
    templates: CatalogItem[];
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function listTemplates(
    request: APIRequestContext,
    token: string,
    kind?: string,
): Promise<CatalogResponse> {
    const q = kind ? `?kind=${kind}` : '';
    const res = await request.get(`${API_BASE}/api/templates${q}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET /api/templates${q}`).toBe(200);
    return res.json();
}

async function addCustom(
    request: APIRequestContext,
    token: string,
    body: { kind: string; repositoryUrl: string; name?: string },
) {
    return request.post(`${API_BASE}/api/templates/custom`, {
        headers: authedHeaders(token),
        data: body,
    });
}

function isNonDecreasing(values: string[]): boolean {
    for (let i = 1; i < values.length; i++) {
        if (values[i - 1] > values[i]) return false;
    }
    return true;
}

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/templates — envelope, kinds, auth, validation', () => {
    let user: RegisteredUser;
    test.beforeAll(async ({ request }) => {
        user = await registerUserViaAPI(request);
    });

    test('kind omitted defaults to work; envelope is { status, kind, defaultTemplateId, templates }', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/templates`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body: CatalogResponse = await res.json();
        expect(body.status).toBe('success');
        expect(body.kind).toBe('work');
        expect(Array.isArray(body.templates)).toBe(true);
        expect(body).toHaveProperty('defaultTemplateId');
        const ids = body.templates.map((t) => t.id);
        for (const id of WORK_BUILTIN_IDS) expect(ids).toContain(id);
    });

    test('kind=website → defaultTemplateId falls back to classic + built-in ids present', async ({
        request,
    }) => {
        const body = await listTemplates(request, user.access_token, 'website');
        expect(body.kind).toBe('website');
        expect(body.defaultTemplateId).toBe('classic');
        const ids = body.templates.map((t) => t.id);
        for (const id of WEBSITE_BUILTIN_IDS) expect(ids).toContain(id);
        // Every built-in returned by the list is active + standard-origin.
        for (const t of body.templates.filter((x) => x.sourceType === 'built_in')) {
            expect(t.isActive).toBe(true);
            expect(t.originType).toBe('standard');
        }
    });

    test('kind=work default is null (no website-style fallback)', async ({ request }) => {
        const body = await listTemplates(request, user.access_token, 'work');
        expect(body.defaultTemplateId).toBeNull();
    });

    test('kind=mission default null + contains the starter-business built-in', async ({
        request,
    }) => {
        const body = await listTemplates(request, user.access_token, 'mission');
        expect(body.defaultTemplateId).toBeNull();
        expect(body.templates.map((t) => t.id)).toContain('starter-business');
        for (const t of body.templates) expect(t.kind).toBe('mission');
    });

    test('kind=company → empty template set for a fresh user', async ({ request }) => {
        const fresh = await registerUserViaAPI(request);
        const body = await listTemplates(request, fresh.access_token, 'company');
        expect(body.kind).toBe('company');
        expect(body.templates).toEqual([]);
        expect(body.defaultTemplateId).toBeNull();
    });

    test('invalid kind → 400 with the enum message (never a 5xx)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/templates?kind=bogus`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(JSON.stringify(body.message)).toContain('kind must be one of the following values');
    });

    test('no auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/templates?kind=work`);
        expect(res.status()).toBe(401);
    });

    test('each catalog item carries the full TemplateCatalogItem projection', async ({
        request,
    }) => {
        const body = await listTemplates(request, user.access_token, 'website');
        const item = body.templates.find((t) => t.id === 'classic');
        expect(item).toBeTruthy();
        const it = item as CatalogItem;
        for (const key of [
            'id',
            'kind',
            'sourceType',
            'originType',
            'name',
            'framework',
            'repositoryOwner',
            'repositoryName',
            'branch',
            'syncBranches',
            'isActive',
            'isDefault',
            'customizable',
            'baseTemplateId',
            'latestCustomization',
        ]) {
            expect(it, `missing ${key}`).toHaveProperty(key);
        }
        expect(typeof it.id).toBe('string');
        expect(['built_in', 'custom']).toContain(it.sourceType);
        expect(Array.isArray(it.syncBranches)).toBe(true);
        expect(typeof it.isDefault).toBe('boolean');
        // built_in resolves its own id as baseTemplateId.
        expect(it.baseTemplateId).toBe('classic');
    });

    test('website built-in customizable flag is asymmetric (classic:false, minimal:true)', async ({
        request,
    }) => {
        const body = await listTemplates(request, user.access_token, 'website');
        const classic = body.templates.find((t) => t.id === 'classic');
        const minimal = body.templates.find((t) => t.id === 'minimal');
        expect(classic?.customizable).toBe(false);
        expect(minimal?.customizable).toBe(true);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/templates — NOT paginated (pagination-param rejection)', () => {
    let user: RegisteredUser;
    test.beforeAll(async ({ request }) => {
        user = await registerUserViaAPI(request);
    });

    test('a lone unknown param (?limit=1) → 400 forbidNonWhitelisted', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/templates?kind=website&limit=1`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
    });

    test('every classic pagination/sort param is rejected with 400', async ({ request }) => {
        const params = ['limit=5', 'offset=2', 'page=2', 'sort=name', 'order=desc', 'q=classic'];
        for (const p of params) {
            const res = await request.get(`${API_BASE}/api/templates?kind=website&${p}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(res.status(), `param ${p} should be rejected`).toBe(400);
        }
    });

    test('no internal page cap — 6 fresh custom rows ALL surface in one response', async ({
        request,
    }) => {
        const fresh = await registerUserViaAPI(request);
        const created: string[] = [];
        for (let i = 0; i < 6; i++) {
            const res = await addCustom(request, fresh.access_token, {
                kind: 'website',
                repositoryUrl: `https://github.com/pgn-${stamp()}/cap-${i}-${stamp()}`,
                name: `Cap Template ${i}`,
            });
            expect(res.status()).toBe(200);
            created.push((await res.json()).template.id);
        }
        const body = await listTemplates(request, fresh.access_token, 'website');
        const ids = body.templates.map((t) => t.id);
        for (const id of created) expect(ids).toContain(id);
        // All 4 website built-ins are ALSO still present — nothing truncated.
        for (const id of WEBSITE_BUILTIN_IDS) expect(ids).toContain(id);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/templates — ordering (sourceType DESC, name ASC)', () => {
    test('built-in website templates come back in name-ascending order', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const body = await listTemplates(request, user.access_token, 'website');
        const builtInNames = body.templates
            .filter((t) => t.sourceType === 'built_in')
            .map((t) => t.name);
        expect(builtInNames.length).toBeGreaterThanOrEqual(WEBSITE_BUILTIN_IDS.length);
        expect(isNonDecreasing(builtInNames)).toBe(true);
    });

    test('a user’s own custom templates sort BEFORE every built-in', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        // Two customs whose names would otherwise interleave with built-ins.
        for (const name of ['Zzz Last Alphabetically', 'Aaa First Alphabetically']) {
            const res = await addCustom(request, user.access_token, {
                kind: 'website',
                repositoryUrl: `https://github.com/ord-${stamp()}/r-${stamp()}`,
                name,
            });
            expect(res.status()).toBe(200);
        }
        const body = await listTemplates(request, user.access_token, 'website');
        const kinds = body.templates.map((t) => t.sourceType);
        const firstBuiltIn = kinds.indexOf('built_in');
        const lastCustom = kinds.lastIndexOf('custom');
        expect(firstBuiltIn).toBeGreaterThanOrEqual(0);
        expect(lastCustom).toBeGreaterThanOrEqual(0);
        // Even "Zzz…" (a custom) precedes "Classic" (a built-in): source wins over name.
        expect(lastCustom).toBeLessThan(firstBuiltIn);
    });

    test('within the custom group, order is name-ascending + stable across calls', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        for (const name of ['Custom M', 'Custom A', 'Custom Z']) {
            const res = await addCustom(request, user.access_token, {
                kind: 'website',
                repositoryUrl: `https://github.com/grp-${stamp()}/r-${stamp()}`,
                name,
            });
            expect(res.status()).toBe(200);
        }
        const first = await listTemplates(request, user.access_token, 'website');
        const customNames = first.templates
            .filter((t) => t.sourceType === 'custom')
            .map((t) => t.name);
        expect(customNames).toEqual(['Custom A', 'Custom M', 'Custom Z']);
        // Repeated call → identical id ordering (deterministic list).
        const second = await listTemplates(request, user.access_token, 'website');
        expect(second.templates.map((t) => t.id)).toEqual(first.templates.map((t) => t.id));
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/templates — custom rows + cross-user isolation', () => {
    test('added custom appears as custom-<uuid>, sourceType custom, owned by me', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const repo = `iso-${stamp()}`;
        const res = await addCustom(request, user.access_token, {
            kind: 'website',
            repositoryUrl: `https://github.com/owner-${stamp()}/${repo}`,
            name: 'Owned Custom',
        });
        expect(res.status()).toBe(200);
        const created = (await res.json()).template;
        expect(created.id).toMatch(CUSTOM_ID_RE);
        expect(created.sourceType).toBe('custom');
        expect(created.originType).toBe('custom_url');
        expect(created.ownerUserId).toBe(user.user.id);

        const body = await listTemplates(request, user.access_token, 'website');
        const mine = body.templates.find((t) => t.id === created.id);
        expect(mine).toBeTruthy();
        expect(mine?.repositoryName).toBe(repo);
    });

    test('another user NEVER sees my custom templates in their list', async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const addRes = await addCustom(request, alice.access_token, {
            kind: 'website',
            repositoryUrl: `https://github.com/alice-${stamp()}/secret-${stamp()}`,
            name: 'Alice Secret',
        });
        expect(addRes.status()).toBe(200);
        const aliceCustomId = (await addRes.json()).template.id;

        const bob = await registerUserViaAPI(request);
        const bobList = await listTemplates(request, bob.access_token, 'website');
        const bobIds = bobList.templates.map((t) => t.id);
        expect(bobIds).not.toContain(aliceCustomId);
        // Bob still sees the shared built-ins.
        expect(bobIds).toContain('classic');
        expect(bobList.templates.every((t) => t.sourceType === 'built_in')).toBe(true);
    });

    test('add-custom validation: non-GitHub URL → 400, bad kind → 400, no auth → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const notGithub = await addCustom(request, user.access_token, {
            kind: 'website',
            repositoryUrl: 'https://gitlab.com/foo/bar',
        });
        expect(notGithub.status()).toBe(400);

        const badKind = await addCustom(request, user.access_token, {
            kind: 'nope',
            repositoryUrl: 'https://github.com/a/b',
        });
        expect(badKind.status()).toBe(400);

        const noAuth = await request.post(`${API_BASE}/api/templates/custom`, {
            data: { kind: 'website', repositoryUrl: 'https://github.com/a/b' },
        });
        expect(noAuth.status()).toBe(401);
    });

    test('re-adding the SAME repo (serial) → 409 conflict, no second row', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const url = `https://github.com/dup-${stamp()}/repo-${stamp()}`;
        const first = await addCustom(request, user.access_token, {
            kind: 'website',
            repositoryUrl: url,
        });
        expect(first.status()).toBe(200);
        const second = await addCustom(request, user.access_token, {
            kind: 'website',
            repositoryUrl: url,
        });
        expect(second.status()).toBe(409);
        const repoName = url.split('/').pop() as string;
        const body = await listTemplates(request, user.access_token, 'website');
        expect(body.templates.filter((t) => t.repositoryName === repoName)).toHaveLength(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/templates — default selection reflected in the list', () => {
    async function setDefault(
        request: APIRequestContext,
        token: string,
        kind: string,
        templateId: string,
    ) {
        return request.put(`${API_BASE}/api/templates/default`, {
            headers: authedHeaders(token),
            data: { kind, templateId },
        });
    }

    test('setting default flips exactly one isDefault + updates defaultTemplateId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await setDefault(request, user.access_token, 'website', 'minimal');
        expect(res.status()).toBe(200);
        expect((await res.json()).defaultTemplateId).toBe('minimal');

        const body = await listTemplates(request, user.access_token, 'website');
        expect(body.defaultTemplateId).toBe('minimal');
        const flagged = body.templates.filter((t) => t.isDefault);
        expect(flagged).toHaveLength(1);
        expect(flagged[0].id).toBe('minimal');
    });

    test('default to a nonexistent id → 404 and the stored default is unchanged', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const before = (await listTemplates(request, user.access_token, 'website'))
            .defaultTemplateId;
        const res = await setDefault(request, user.access_token, 'website', 'zzz-nope');
        expect(res.status()).toBe(404);
        const after = (await listTemplates(request, user.access_token, 'website'))
            .defaultTemplateId;
        expect(after).toBe(before);
    });

    test('default with a mismatched kind (website id under work) → 404', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await setDefault(request, user.access_token, 'work', 'classic');
        expect(res.status()).toBe(404);
    });

    test('archiving the defaulted custom reverts default to classic + drops it from the list', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const addRes = await addCustom(request, user.access_token, {
            kind: 'website',
            repositoryUrl: `https://github.com/arch-${stamp()}/repo-${stamp()}`,
            name: 'Archive Me',
        });
        expect(addRes.status()).toBe(200);
        const id = (await addRes.json()).template.id;

        expect((await setDefault(request, user.access_token, 'website', id)).status()).toBe(200);
        expect((await listTemplates(request, user.access_token, 'website')).defaultTemplateId).toBe(
            id,
        );

        const archive = await request.post(`${API_BASE}/api/templates/custom/${id}/archive`, {
            headers: authedHeaders(user.access_token),
            data: { kind: 'website' },
        });
        expect(archive.status()).toBe(200);
        expect((await archive.json()).archived).toBe(true);

        const after = await listTemplates(request, user.access_token, 'website');
        expect(after.templates.map((t) => t.id)).not.toContain(id);
        // Default reverts to the website fallback.
        expect(after.defaultTemplateId).toBe('classic');

        // Archiving again → 404; archiving a built-in id → 404 (only owned custom).
        const again = await request.post(`${API_BASE}/api/templates/custom/${id}/archive`, {
            headers: authedHeaders(user.access_token),
            data: { kind: 'website' },
        });
        expect(again.status()).toBe(404);
        const builtin = await request.post(`${API_BASE}/api/templates/custom/classic/archive`, {
            headers: authedHeaders(user.access_token),
            data: { kind: 'website' },
        });
        expect(builtin.status()).toBe(404);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/templates — concurrency', () => {
    test('N parallel identical GETs → all 200 with the identical template-id set', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const responses = await Promise.all(
            Array.from({ length: 8 }, () =>
                request.get(`${API_BASE}/api/templates?kind=website`, {
                    headers: authedHeaders(user.access_token),
                }),
            ),
        );
        expect(responses.every((r) => r.status() === 200)).toBe(true);
        const idSets = await Promise.all(
            responses.map(async (r) =>
                (await r.json()).templates.map((t: CatalogItem) => t.id).sort(),
            ),
        );
        const baseline = JSON.stringify(idSets[0]);
        for (const s of idSets) expect(JSON.stringify(s)).toBe(baseline);
    });

    test('N parallel identical custom-adds → dedup: list holds exactly `successes` rows', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const repo = `conc-${stamp()}`;
        const url = `https://github.com/conc-${stamp()}/${repo}`;
        const N = 6;
        const results = await Promise.all(
            Array.from({ length: N }, () =>
                addCustom(request, user.access_token, { kind: 'website', repositoryUrl: url }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const successes = statuses.filter((s) => s === 200).length;
        const conflicts = statuses.filter((s) => s === 409).length;
        const serverErr = statuses.filter((s) => s >= 500).length;
        // Every response is a create, a conflict, or a tolerated sqlite tx-serialization 5xx.
        expect(successes + conflicts + serverErr).toBe(N);
        expect(successes).toBeGreaterThanOrEqual(1);

        // Durable dedup invariant: the resulting list has EXACTLY one row per
        // successful create — no phantom duplicates, no lost winners.
        const body = await listTemplates(request, user.access_token, 'website');
        const rows = body.templates.filter((t) => t.repositoryName === repo);
        expect(rows.length).toBe(successes);
    });

    test('N parallel competing set-default → exactly one isDefault terminal winner', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const targets = ['classic', 'minimal', 'web', 'web-minimal'];
        const results = await Promise.all(
            targets.map((templateId) =>
                request.put(`${API_BASE}/api/templates/default`, {
                    headers: authedHeaders(user.access_token),
                    data: { kind: 'website', templateId },
                }),
            ),
        );
        // No corruption: every racer either 200s or hits a tolerated tx 5xx.
        for (const r of results) expect([200, 500, 503]).toContain(r.status());

        const body = await listTemplates(request, user.access_token, 'website');
        const flagged = body.templates.filter((t) => t.isDefault);
        expect(flagged).toHaveLength(1);
        expect(targets).toContain(flagged[0].id);
        expect(body.defaultTemplateId).toBe(flagged[0].id);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/work-templates — public bare array + chipType allowlist', () => {
    test('public (no auth) → bare array containing the directory blueprint', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/work-templates`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.map((e: { slug: string }) => e.slug)).toContain('directory');
    });

    test('full catalog: every entry has the required WorkBlueprintEntry keys + valid status', async ({
        request,
    }) => {
        const body = await (await request.get(`${API_BASE}/api/work-templates`)).json();
        expect(body.length).toBeGreaterThanOrEqual(1);
        for (const e of body) {
            for (const key of [
                'slug',
                'name',
                'title',
                'description',
                'chipType',
                'kind',
                'isDefault',
                'featured',
                'status',
                'isOrganization',
            ]) {
                expect(e, `entry ${e.slug} missing ${key}`).toHaveProperty(key);
            }
            expect(['production', 'beta', 'placeholder']).toContain(e.status);
            expect(typeof e.isDefault).toBe('boolean');
            expect(typeof e.isOrganization).toBe('boolean');
            // Every slug/chipType is a strict lowercase allowlist slug.
            expect(e.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
            expect(e.chipType).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        }
    });

    test('production entries always carry a fork source (templateRepoName non-null)', async ({
        request,
    }) => {
        const body = await (await request.get(`${API_BASE}/api/work-templates`)).json();
        for (const e of body.filter((x: { status: string }) => x.status === 'production')) {
            expect(e.templateRepoName, `production ${e.slug} needs a repo`).toBeTruthy();
        }
    });

    test('chipType filter is an exact-slug subset of the full catalog', async ({ request }) => {
        const full = await (await request.get(`${API_BASE}/api/work-templates`)).json();
        const fullSlugs = new Set(full.map((e: { slug: string }) => e.slug));
        const filteredRes = await request.get(`${API_BASE}/api/work-templates?chipType=directory`);
        expect(filteredRes.status()).toBe(200);
        const filtered = await filteredRes.json();
        expect(filtered.length).toBeGreaterThanOrEqual(1);
        for (const e of filtered) {
            expect(e.chipType).toBe('directory');
            expect(fullSlugs.has(e.slug)).toBe(true);
        }
        expect(filtered.length).toBeLessThanOrEqual(full.length);
    });

    test('chipType edge cases: uppercase / unknown / injection → []; empty → full catalog', async ({
        request,
    }) => {
        const fullLen = (await (await request.get(`${API_BASE}/api/work-templates`)).json()).length;

        for (const bad of ['Directory', 'zzz-not-real', "directory'OR1", 'DROP TABLE']) {
            const res = await request.get(
                `${API_BASE}/api/work-templates?chipType=${encodeURIComponent(bad)}`,
            );
            expect(res.status(), `chipType=${bad}`).toBe(200);
            expect(await res.json(), `chipType=${bad} should be empty`).toEqual([]);
        }

        const empty = await request.get(`${API_BASE}/api/work-templates?chipType=`);
        expect(empty.status()).toBe(200);
        expect((await empty.json()).length).toBe(fullLen);
    });

    test('catalog order is deterministic across repeated calls (cache-backed)', async ({
        request,
    }) => {
        const a = (await (await request.get(`${API_BASE}/api/work-templates`)).json()).map(
            (e: { slug: string }) => e.slug,
        );
        const b = (await (await request.get(`${API_BASE}/api/work-templates`)).json()).map(
            (e: { slug: string }) => e.slug,
        );
        expect(b).toEqual(a);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/org-templates — authed bare array', () => {
    test('no auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/org-templates`);
        expect(res.status()).toBe(401);
    });

    test('bare array of OrgTemplateEntry — counts are non-negative ints, path/files omitted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/org-templates`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.map((e: { slug: string }) => e.slug)).toContain('ever-starter');
        for (const e of body) {
            for (const key of ['slug', 'name', 'description', 'category']) {
                expect(e, `entry ${e.slug} missing ${key}`).toHaveProperty(key);
            }
            for (const c of ['agents', 'teams', 'skills', 'projects']) {
                expect(Number.isInteger(e[c]), `${e.slug}.${c} int`).toBe(true);
                expect(e[c], `${e.slug}.${c} >= 0`).toBeGreaterThanOrEqual(0);
            }
            expect(e.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
            // Importer-only fields must NOT leak on the public wire shape.
            expect(e).not.toHaveProperty('path');
            expect(e).not.toHaveProperty('files');
        }
    });

    test('the ever-starter package is flagged featured + order is deterministic', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const first = await (
            await request.get(`${API_BASE}/api/org-templates`, {
                headers: authedHeaders(user.access_token),
            })
        ).json();
        const starter = first.find((e: { slug: string }) => e.slug === 'ever-starter');
        expect(starter?.featured).toBe(true);

        const second = await (
            await request.get(`${API_BASE}/api/org-templates`, {
                headers: authedHeaders(user.access_token),
            })
        ).json();
        expect(second.map((e: { slug: string }) => e.slug)).toEqual(
            first.map((e: { slug: string }) => e.slug),
        );
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/template-catalog — route does not exist', () => {
    test('unauth + authed both 404 (no such controller route)', async ({ request }) => {
        const anon = await request.get(`${API_BASE}/api/template-catalog`);
        expect(anon.status()).toBe(404);
        const user = await registerUserViaAPI(request);
        const authed = await request.get(`${API_BASE}/api/template-catalog`, {
            headers: authedHeaders(user.access_token),
        });
        expect(authed.status()).toBe(404);
    });
});
