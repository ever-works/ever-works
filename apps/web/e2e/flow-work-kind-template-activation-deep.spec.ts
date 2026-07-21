/**
 * Work-kind template activation — DEEP end-to-end (#1687 / #1703 / #1704).
 *
 * `POST /api/works` accepts an OPTIONAL `kind` field (the work-kind chip the
 * user picks at creation: website | landing-page | blog | directory |
 * awesome-repo). Persisting `work.kind` is what later lets
 * `WebsiteTemplateResolverService.resolveForWork` apply a KIND-AWARE default
 * website template — general-purpose kinds (website / landing-page / blog)
 * resolve to the `web` template instead of the classic directory template.
 * This file drives the real API against a live stack and pins the true
 * response shapes + status codes, covering:
 *
 *   • create persists a valid chip verbatim; envelope { status:'success', work }
 *   • the whole USER_SELECTABLE_WORK_KINDS set round-trips (website, landing-page,
 *     blog, directory, awesome-repo)
 *   • DTO whitelist coercion via normalizeCreateWorkKind:
 *       - 'landing' alias → 'landing-page'
 *       - 'WEBSITE' / '  website  ' → 'website' (lower-cased + trimmed)
 *       - reserved 'company' → 'default' (the general create path can NEVER mint
 *         a Company Work — that stays exclusive to the Register-Company flow)
 *       - unknown string / numeric / null / '' / omitted → 'default'
 *   • kind persists on GET re-read and is echoed in the works listing
 *   • the kind→template contract: websiteTemplateId is NULL at create even for a
 *     web-mapped kind (the kind-aware default is resolved LATER, at website
 *     generation) — but an EXPLICIT websiteTemplateId sticks alongside the kind
 *   • an unknown websiteTemplateId → 400; the catalog exposes both the `classic`
 *     default and the kind-activated `web` template (GET /api/templates?kind=website)
 *   • forbidNonWhitelisted: an unknown create field → 400 "property X should not exist"
 *   • kind is CREATE-ONLY: PUT { kind } → 400 (UpdateWorkDto has no kind); a
 *     name-only PUT leaves kind untouched
 *   • validation: missing organization 400, bad slug 400, unauth 401
 *   • cross-user isolation: a stranger reading a kinded work → 403/404
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before assertions were written. Source of truth:
 *      packages/agent/src/dto/create-work.dto.ts        (CreateWorkDto.kind)
 *      packages/agent/src/entities/work.entity.ts        (normalizeCreateWorkKind,
 *                                                          USER_SELECTABLE_WORK_KINDS)
 *      packages/agent/src/services/work-lifecycle.service.ts (createWork)
 *      packages/agent/src/generators/website-generator/config/website-template.config.ts
 *                                                          (KIND_DEFAULT_WEBSITE_TEMPLATE)
 *
 * Fully API-orchestrated; fresh registerUserViaAPI() owners per test (safe
 * `flow-` prefix, not matched by the no-auth testIgnore regex).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const WORKS_BASE = `${API_BASE}/api/works`;
const TEMPLATES_URL = `${API_BASE}/api/templates`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

// The closed set of user-selectable work-kind chips (mirrors
// USER_SELECTABLE_WORK_KINDS in work.entity.ts). Each of these persists
// verbatim; general-purpose kinds additionally drive the kind-aware `web`
// website template downstream.
const USER_SELECTABLE_KINDS = ['website', 'landing-page', 'blog', 'directory', 'awesome-repo'];

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function uniqSlug(base: string): string {
    return `${base}-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

interface WorkRecord {
    id: string;
    name?: string;
    slug?: string;
    kind?: string;
    status?: string;
    websiteTemplateId?: string | null;
    organization?: boolean;
    organizationId?: string | null;
    [k: string]: unknown;
}

interface CreateResult {
    status: number;
    text: string;
    json: { status?: string; work?: WorkRecord } | null;
    work: WorkRecord | null;
}

/**
 * Raw create — POSTs an arbitrary body (so tests can send coercion inputs,
 * bogus fields, or omit required fields) and never throws on !ok.
 */
async function createWorkRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<CreateResult> {
    const res = await request.post(WORKS_BASE, { headers: authedHeaders(token), data: body });
    const text = await res.text();
    let json: CreateResult['json'] = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    const work = (json?.work as WorkRecord) ?? (json as unknown as WorkRecord) ?? null;
    return { status: res.status(), text, json, work };
}

/** A minimal valid create body; `extra` layers on kind / websiteTemplateId / etc. */
function workBody(slugBase: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name: `${slugBase} ${stamp()}`,
        slug: uniqSlug(slugBase),
        description: 'work-kind template activation e2e',
        organization: false,
        ...extra,
    };
}

/** Create a work expecting the happy-path 200 envelope; returns the work. */
async function createWorkOk(
    request: APIRequestContext,
    token: string,
    slugBase: string,
    extra: Record<string, unknown> = {},
): Promise<WorkRecord> {
    const res = await createWorkRaw(request, token, workBody(slugBase, extra));
    expect(res.status, `create "${slugBase}" body=${res.text.slice(0, 300)}`).toBe(200);
    expect(res.json?.status).toBe('success');
    expect(res.work?.id).toMatch(UUID_RE);
    return res.work as WorkRecord;
}

test.describe('Work-kind template activation — create persists the chip', () => {
    test('a valid chip is persisted verbatim; envelope + status shape; websiteTemplateId is deferred', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkOk(request, user.access_token, 'website-chip', {
            kind: 'website',
        });
        // The chip sticks — this is what activates the kind-aware `web` template downstream.
        expect(work.kind).toBe('website');
        // Existing-shape works are created live ('active').
        expect(work.status).toBe('active');
        // The kind-aware template default is resolved LATER (at website generation),
        // NOT at create — so the create response carries no explicit template yet.
        expect(work.websiteTemplateId ?? null).toBeNull();
        // No org linkage at create.
        expect(work.organizationId ?? null).toBeNull();
    });

    test('every user-selectable kind round-trips verbatim', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        for (const kind of USER_SELECTABLE_KINDS) {
            const work = await createWorkOk(request, user.access_token, `kind-${kind}`, { kind });
            expect(work.kind, `kind '${kind}' persists verbatim`).toBe(kind);
            expect(work.websiteTemplateId ?? null, `kind '${kind}' template deferred`).toBeNull();
        }
    });

    test("the 'landing' alias normalizes to the canonical 'landing-page'", async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkOk(request, user.access_token, 'alias', { kind: 'landing' });
        expect(work.kind).toBe('landing-page');
    });

    test('case + surrounding whitespace are normalized by the DTO transform', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const upper = await createWorkOk(request, user.access_token, 'upcase', { kind: 'WEBSITE' });
        expect(upper.kind).toBe('website');
        const spacey = await createWorkOk(request, user.access_token, 'spacey', {
            kind: '  website  ',
        });
        expect(spacey.kind).toBe('website');
    });

    test('omitted / null / empty-string kind all fall through to the column default', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const omitted = await createWorkOk(request, user.access_token, 'omitted');
        expect(omitted.kind, 'omitted kind → default').toBe('default');
        const nullish = await createWorkOk(request, user.access_token, 'nullish', { kind: null });
        expect(nullish.kind, 'null kind → default').toBe('default');
        const empty = await createWorkOk(request, user.access_token, 'empty', { kind: '' });
        expect(empty.kind, 'empty kind → default').toBe('default');
    });

    test("the reserved 'company' kind is coerced to default — the create path never mints a Company Work", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkOk(request, user.access_token, 'company-attempt', {
            kind: 'company',
        });
        expect(work.kind, "'company' is coerced to 'default'").toBe('default');
        // And it is NOT a company work: no org linkage, plain active status.
        expect(work.organizationId ?? null).toBeNull();
        expect(work.status).toBe('active');
    });

    test('unknown-string and numeric kinds are coerced to default — arbitrary input never reaches the column', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const bogus = await createWorkOk(request, user.access_token, 'bogus', {
            kind: 'totally-not-a-kind',
        });
        expect(bogus.kind, 'unknown string → default').toBe('default');
        const injected = await createWorkOk(request, user.access_token, 'injected', {
            kind: '<script>alert(1)</script>',
        });
        expect(injected.kind, 'injection attempt → default').toBe('default');
        // A non-string value is coerced (normalizeCreateWorkKind returns 'default' for non-strings)
        // rather than rejected — the create still succeeds with a safe value.
        const numeric = await createWorkOk(request, user.access_token, 'numeric', { kind: 123 });
        expect(numeric.kind, 'numeric → default').toBe('default');
    });

    test('the persisted kind survives a GET re-read', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const created = await createWorkOk(request, user.access_token, 'persist', { kind: 'blog' });
        const got = await request.get(`${WORKS_BASE}/${created.id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(got.status()).toBe(200);
        const body = await got.json();
        const work = (body.work ?? body) as WorkRecord;
        expect(work.id).toBe(created.id);
        expect(work.kind, 'kind persists on re-read').toBe('blog');
        expect(work.websiteTemplateId ?? null, 'template still deferred on GET').toBeNull();
    });

    test('the works listing echoes the kind for the created work', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const created = await createWorkOk(request, user.access_token, 'listed', {
            kind: 'directory',
        });
        const list = await request.get(`${WORKS_BASE}?limit=100`, {
            headers: authedHeaders(user.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        const rows = (body.works ?? body.data ?? body.items ?? body) as WorkRecord[];
        const mine = rows.find((w) => w.id === created.id);
        expect(mine, 'created work appears in the listing').toBeTruthy();
        expect(mine!.kind, 'listing echoes the persisted kind').toBe('directory');
    });
});

test.describe('Work-kind template activation — the kind→website-template contract', () => {
    test('a web-mapped kind leaves websiteTemplateId null at create (resolution is deferred)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // 'blog' maps to the `web` template in KIND_DEFAULT_WEBSITE_TEMPLATE, but that
        // default is only applied by the resolver at website-generation time. At create
        // the column stays null — only the KIND is persisted.
        const work = await createWorkOk(request, user.access_token, 'blog-deferred', {
            kind: 'blog',
        });
        expect(work.kind).toBe('blog');
        expect(work.websiteTemplateId ?? null).toBeNull();
    });

    test('an explicit websiteTemplateId sticks alongside the kind (explicit classic + website chip)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkOk(request, user.access_token, 'explicit-classic', {
            kind: 'website',
            websiteTemplateId: 'classic',
        });
        expect(work.kind, 'kind is still persisted').toBe('website');
        expect(work.websiteTemplateId, 'explicit template wins over the kind default').toBe(
            'classic',
        );
    });

    test('an explicit web template is honored on a web-mapped kind (blog + web)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkOk(request, user.access_token, 'explicit-web', {
            kind: 'blog',
            websiteTemplateId: 'web',
        });
        expect(work.kind).toBe('blog');
        expect(work.websiteTemplateId).toBe('web');
    });

    test('an unknown websiteTemplateId is rejected (400)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await createWorkRaw(
            request,
            user.access_token,
            workBody('bad-template', { kind: 'website', websiteTemplateId: 'does-not-exist-xyz' }),
        );
        expect(res.status, `body=${res.text.slice(0, 300)}`).toBe(400);
    });

    test('the template catalog exposes both the classic default and the kind-activated web template', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${TEMPLATES_URL}?kind=website`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('success');
        expect(body.kind).toBe('website');
        // The system default that non-web kinds (directory / awesome-repo / default) fall through to.
        expect(body.defaultTemplateId).toBe('classic');
        const ids = (body.templates as Array<{ id: string }>).map((t) => t.id);
        // The `web` template is the one general-purpose kinds activate; `classic` is the default.
        expect(ids, 'catalog contains the classic default').toContain('classic');
        expect(ids, 'catalog contains the kind-activated web template').toContain('web');

        // Unauthenticated → 401; an unknown template kind → 400.
        expect((await request.get(`${TEMPLATES_URL}?kind=website`)).status()).toBe(401);
        const badKind = await request.get(`${TEMPLATES_URL}?kind=not-a-real-kind`, {
            headers: authedHeaders(user.access_token),
        });
        expect(badKind.status()).toBe(400);
    });
});

test.describe('Work-kind template activation — whitelist, immutability, validation, isolation', () => {
    test('forbidNonWhitelisted: an unknown create field is rejected with a stable message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await createWorkRaw(
            request,
            user.access_token,
            workBody('unknown-field', { kind: 'website', bogusField: 'x' }),
        );
        expect(res.status).toBe(400);
        // The global ValidationPipe runs forbidNonWhitelisted → property-level rejection.
        expect(res.text).toContain('bogusField');
        expect(res.text).toContain('should not exist');
    });

    test('kind is create-only: a PUT carrying kind is rejected (UpdateWorkDto has no kind)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkOk(request, user.access_token, 'immutable', { kind: 'blog' });
        const put = await request.put(`${WORKS_BASE}/${work.id}`, {
            headers: authedHeaders(user.access_token),
            data: { kind: 'website' },
        });
        expect(put.status(), `put body=${await put.text().catch(() => '')}`).toBe(400);
        expect(await put.text().catch(() => '')).toContain('kind');
    });

    test('a name-only PUT leaves the persisted kind untouched', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkOk(request, user.access_token, 'rename', {
            kind: 'landing-page',
        });
        const renamed = `Renamed ${stamp()}`;
        const put = await request.put(`${WORKS_BASE}/${work.id}`, {
            headers: authedHeaders(user.access_token),
            data: { name: renamed },
        });
        expect(put.status()).toBe(200);
        const got = await request.get(`${WORKS_BASE}/${work.id}`, {
            headers: authedHeaders(user.access_token),
        });
        const body = await got.json();
        const after = (body.work ?? body) as WorkRecord;
        expect(after.name).toBe(renamed);
        expect(after.kind, 'kind is unchanged by an unrelated update').toBe('landing-page');
    });

    test('validation: missing organization 400, bad slug 400 (kind present in both bodies)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // `organization` is a REQUIRED boolean; omitting it 400s even with a valid kind.
        const missingOrg = await createWorkRaw(request, user.access_token, {
            name: `MO ${stamp()}`,
            slug: uniqSlug('missing-org'),
            description: 'd',
            kind: 'website',
        });
        expect(missingOrg.status).toBe(400);
        expect(missingOrg.text).toContain('organization');
        // A slug that violates the ^[a-z0-9]+(?:-[a-z0-9]+)*$ pattern 400s.
        const badSlug = await createWorkRaw(request, user.access_token, {
            name: `BS ${stamp()}`,
            slug: 'Bad Slug!',
            description: 'd',
            organization: false,
            kind: 'website',
        });
        expect(badSlug.status).toBe(400);
    });

    test('an unauthenticated create is rejected (401)', async ({ request }) => {
        const res = await request.post(WORKS_BASE, { data: workBody('anon', { kind: 'website' }) });
        expect(res.status()).toBe(401);
    });

    test("cross-user isolation: a stranger cannot read another owner's kinded work", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkOk(request, owner.access_token, 'private-kind', {
            kind: 'website',
        });

        // The owner reads it fine…
        const ownerGet = await request.get(`${WORKS_BASE}/${work.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerGet.status()).toBe(200);
        const ownerBody = await ownerGet.json();
        expect(((ownerBody.work ?? ownerBody) as WorkRecord).kind).toBe('website');

        // …a stranger is walled off (live: 403; tolerate 404).
        const strangerGet = await request.get(`${WORKS_BASE}/${work.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect([403, 404]).toContain(strangerGet.status());

        // A well-formed but unknown id → 404 (route is not strictly UUID-validated).
        const unknown = await request.get(`${WORKS_BASE}/${UNKNOWN_UUID}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect([403, 404]).toContain(unknown.status());
    });
});
