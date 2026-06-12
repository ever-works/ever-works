import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-works-website-settings-deep.spec.ts — Works website-settings + config
 * LONG-TAIL deep coverage (the per-Work directory-site configuration surface).
 *
 * SCOPE — the website-settings / config accessors on the Works controller
 * (apps/api/src/works/works.controller.ts → WorkQueryService in
 * packages/agent/src/services/work-query.service.ts), backed by
 * UpdateWebsiteSettingsDto (packages/agent/src/dto/website-settings.dto.ts):
 *   GET /api/works/website-templates   (auth requirement)
 *   GET /api/works/:id/config          (exact null-config envelope + cache)
 *   GET /api/works/:id/website-settings (— sibling-covered; reused only as a
 *                                          read-back oracle for the git gate)
 *   PUT /api/works/:id/website-settings (the FULL nested-DTO validation matrix
 *                                          + the custom_menu href-security gate
 *                                          + the all-optional empty-body git gate)
 *
 * NON-DUPLICATION — three sibling specs already own large parts of this area;
 * this file deliberately AVOIDS what they pin and fills only the GAPS:
 *   - flow-works-crud-meta-deep.spec.ts pins: the website-templates per-row
 *     registry shape, website-settings GET seeded company_name, the
 *     unknown-property whitelist 400, the company_website `javascript:` 400,
 *     the VALID-body git gate + unchanged-GET, and the foreign-403 / nonexistent-404
 *     / anon-401 LATTICE across config + website-settings. → NOT repeated here.
 *   - flow-website-template-catalog.spec.ts pins: the rich `/api/templates`
 *     catalog, the lean works-facing projection, switch-website-template, the
 *     auto-update flags, and the customization ledger. → NOT repeated here.
 *   - work-stats-config.spec.ts: shallow smoke (config `typeof==='object'`,
 *     website-settings `<500`, "templates may be 200 OR 401"). This file
 *     REPLACES that ambiguity with the EXACT probed contracts.
 * The GAPS pinned below — every nested DTO validator (theme_default IsIn,
 * import_max_rows Min/Max/Int, the MaxLength caps), the custom_menu path
 * scheme/open-redirect guard + target-enum + label-cap, a VALID custom_menu
 * reaching the git gate, the empty-body git gate, the exact `config:null`
 * envelope + cache stability, and the website-templates AUTH REQUIREMENT —
 * are touched by no sibling.
 *
 * GROUND TRUTH — every status / message / shape below was LIVE-PROBED against
 * the running sqlite-in-memory CI driver (http://127.0.0.1:3100,
 * REQUIRE_EMAIL_VERIFICATION off, keyless, NO MailHog/Redis, no connected git)
 * on 2026-06-12 BEFORE any assertion, and cross-read against the controller +
 * WorkQueryService + UpdateWebsiteSettingsDto cited above.
 *
 * PROBED CONTRACTS (exact, live):
 *
 *   GET /api/works/website-templates  (getWebsiteTemplates):
 *     - AUTH REQUIRED: an anonymous request → 401 { message:'Unauthorized',
 *       statusCode:401 }. (Despite the stale "intentionally public" comment in
 *       work-stats-config.spec.ts, the route is guard-protected — this pins the
 *       authed-only contract so a future @Public() slip is caught.)
 *
 *   GET /api/works/:id/config  (getWorkConfig → WorkQueryService.workConfig →
 *        DataGenerator.getConfig):
 *     - own work, no website repo (CI) → 200 { status:'success', config:null }.
 *       The service maps the "read-only repo unavailable" generator error to a
 *       graceful null config (isReadOnlyRepoUnavailable). Pins the EXACT
 *       `config:null` envelope (siblings only assert typeof==='object').
 *     - the handler caches per (workId,userId): two reads return the identical
 *       envelope (cache-stability, never a divergent/partial second read).
 *     - foreign user → 403 'You do not have permission to access this work'
 *       (ensureCanView precedes the config build — distinct from the meta
 *       lattice, asserted here against the config envelope specifically).
 *
 *   PUT /api/works/:id/website-settings  (updateWebsiteSettings,
 *        UpdateWebsiteSettingsDto, whitelist + nested ValidateNested, runs the
 *        global ValidationPipe BEFORE the git-gated write):
 *     - header.theme_default not in {light,dark,system} → 400
 *         ['header.theme_default must be one of the following values: light, dark, system']
 *     - import_max_rows > 2000 → 400 ['import_max_rows must not be greater than 2000']
 *     - import_max_rows non-int → 400 [ '…must not be greater than 2000',
 *         '…must not be less than 1', 'import_max_rows must be an integer number' ]
 *     - company_name > 100 chars → 400 ['company_name must be shorter than or equal to 100 characters']
 *     - homepage.default_view > 20 chars → 400 ['homepage.default_view must be shorter than or equal to 20 characters']
 *     - categories_enabled non-boolean → 400 ['categories_enabled must be a boolean value']
 *     - custom_menu.header[].path = 'javascript:alert(1)' → 400
 *         ['custom_menu.header.0.path must be a relative path (starting with /) or an http(s):// URL']
 *       (SECURITY: menu hrefs render as <a href> on the public site; the DTO
 *        @Matches gate blocks javascript:/data: schemes from reaching an href.)
 *     - custom_menu.header[].path = '//evil.com' (protocol-relative open-redirect)
 *         → 400 SAME path message. (SECURITY: the single-leading-slash rule
 *           rejects `//host` so a stored menu link can't silently retarget off-site.)
 *     - custom_menu.footer[].target = '_top' → 400
 *         ['custom_menu.footer.0.target must be one of the following values: _self, _blank']
 *     - custom_menu.header[].label > 50 chars → 400
 *         ['custom_menu.header.0.label must be shorter than or equal to 50 characters']
 *     - A VALID custom_menu (relative path '/home') PASSES validation and hits
 *       the GIT-GATED write → 400 { status:'error',
 *         message:'Please reconnect your Git account to continue.' }.
 *       So even a structurally-valid menu does NOT round-trip in CI.
 *     - An EMPTY body {} (every field optional) PASSES validation with nothing
 *       to short-circuit and hits the SAME git gate → 400 { status:'error',
 *         message:'Please reconnect your Git account to continue.' }.
 *     - foreign user (EDIT-access guard, ensureCanEdit) → 403
 *         'You do not have permission to access this work'; the owner's GET is
 *         unchanged afterward (the rejected write never landed).
 *
 *   Per-:id id resolution (works `:id` is NOT ParseUUIDPipe-guarded, unlike the
 *     templates/customizations route): a syntactically-malformed id ('not-a-uuid')
 *     for the OWNER → 404 { status:'error', message:"Work with id 'not-a-uuid' not found" }
 *     on BOTH /config and /website-settings (a not-found, never a 400 format error).
 *
 * House rules honoured: fresh registerUserViaAPI() owner + fresh work per
 * mutation; per-spec monotonic counter for unique slugs (NO module-scope clock /
 * no module-scope await); anon via an explicit empty header set; keyless- and
 * git-less-adaptive — every WRITE is asserted as the TYPED GIT GATE, never a
 * git-backed mutation success; API-contract assertions only (no UI nav); TS strict.
 */

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const GIT_GATE_MESSAGE = 'Please reconnect your Git account to continue.';
const NO_PERMISSION = 'You do not have permission to access this work';

/** Per-spec monotonic counter — seeds unique slugs without a module-scope clock. */
let seq = 0;
function uniq(tag: string): string {
    seq += 1;
    return `${tag}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

interface Envelope {
    status?: string;
    statusCode?: number;
    error?: string;
    message?: string | string[];
    config?: unknown;
    company_name?: string;
    company_website?: string;
    settings?: Record<string, unknown>;
    custom_menu?: { header: unknown[]; footer: unknown[] };
}

async function readBody<T = Envelope>(res: {
    status(): number;
    text(): Promise<string>;
}): Promise<{ status: number; body: T; text: string }> {
    const text = await res.text().catch(() => '');
    let body: T;
    try {
        body = JSON.parse(text || '{}') as T;
    } catch {
        body = {} as T;
    }
    return { status: res.status(), body, text };
}

function messages(body: Envelope): string[] {
    if (Array.isArray(body.message)) return body.message;
    if (typeof body.message === 'string') return [body.message];
    return [];
}

/** Create a fresh owner + a fresh work, returning the token + work id. */
async function ownerWithWork(
    request: APIRequestContext,
    tag: string,
): Promise<{ token: string; workId: string; name: string }> {
    const owner = await registerUserViaAPI(request);
    const name = `WS ${uniq(tag)}`;
    const work = await createWorkViaAPI(request, owner.access_token, { name });
    expect(work.id, 'createWorkViaAPI returned a work id').toBeTruthy();
    return { token: owner.access_token, workId: work.id, name };
}

/** PUT a website-settings body and return the parsed result. */
async function putSettings(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<{ status: number; body: Envelope; text: string }> {
    return readBody(
        await request.put(`${API_BASE}/api/works/${workId}/website-settings`, {
            headers: authedHeaders(token),
            data,
        }),
    );
}

test.describe('flow-works-website-settings-deep — Works website config long-tail', () => {
    // ─── website-templates AUTH requirement ────────────────────────────────────
    test('GET /works/website-templates REQUIRES auth — an anonymous request → 401 (the route is NOT public)', async ({
        request,
    }) => {
        // The legacy work-stats-config smoke tolerated "200 OR 401"; the live
        // route is guard-protected, so anon is a hard 401. Pinning this catches a
        // future @Public() regression that would expose the registry unauthenticated.
        const { status, body } = await readBody(
            await request.get(`${API_BASE}/api/works/website-templates`, { headers: {} }),
        );
        expect(status, 'anon website-templates → 401').toBe(401);
        expect(body.statusCode, 'anon 401 statusCode').toBe(401);
        expect(body.message, 'anon 401 message').toBe('Unauthorized');
    });

    // ─── config — exact null envelope + cache stability ────────────────────────
    test('GET /works/:id/config on a fresh repo-less work → 200 { status:"success", config:null } and is cache-stable across re-reads', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'cfg-null');

        // In CI no website repo is ever created → DataGenerator.getConfig hits the
        // read-only-repo-unavailable branch, which the service maps to a graceful
        // null config (NOT a 4xx/5xx). Pin the EXACT envelope.
        const first = await readBody(
            await request.get(`${API_BASE}/api/works/${workId}/config`, {
                headers: authedHeaders(token),
            }),
        );
        expect(first.status, 'own config → 200').toBe(200);
        expect(first.body.status, 'config success envelope').toBe('success');
        expect(first.body.config, 'repo-less work resolves to a null config').toBeNull();

        // The handler caches per (workId,userId); a second read returns the
        // identical envelope — never a divergent or partially-built config.
        const second = await readBody(
            await request.get(`${API_BASE}/api/works/${workId}/config`, {
                headers: authedHeaders(token),
            }),
        );
        expect(second.status, 'cached config re-read → 200').toBe(200);
        expect(second.body.status).toBe('success');
        expect(second.body.config, 'cached re-read is still null (stable)').toBeNull();
        expect(second.text, 'the cached envelope is byte-identical to the first read').toBe(
            first.text,
        );
    });

    test('GET /works/:id/config for a FOREIGN user → 403 (ensureCanView precedes the config build; no config leak)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'cfg-foreign');
        const stranger = await registerUserViaAPI(request);

        const { status, body } = await readBody(
            await request.get(`${API_BASE}/api/works/${workId}/config`, {
                headers: authedHeaders(stranger.access_token),
            }),
        );
        expect(status, 'foreign config → 403').toBe(403);
        expect(body.status, 'foreign config error envelope').toBe('error');
        expect(body.message, 'foreign config permission message').toBe(NO_PERMISSION);
        // The error envelope carries NO config payload.
        expect(body.config, 'no config field leaks in the 403 envelope').toBeUndefined();

        // The owner can still read it — the rejected foreign read was a no-op.
        const ownerView = await readBody(
            await request.get(`${API_BASE}/api/works/${workId}/config`, {
                headers: authedHeaders(token),
            }),
        );
        expect(ownerView.status, 'owner config still readable').toBe(200);
        expect(ownerView.body.config, 'owner config still null').toBeNull();
    });

    // ─── PUT validation: nested ValidateNested + scalar caps (none sibling-pinned) ─
    test('PUT /works/:id/website-settings runs the FULL nested-DTO validation matrix BEFORE the git gate (theme_default / import_max_rows / MaxLength / boolean)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'val-matrix');

        // header.theme_default is a nested @IsIn — an off-enum value is rejected
        // with the dotted-path class-validator message.
        const theme = await putSettings(request, token, workId, {
            header: { theme_default: 'neon' },
        });
        expect(theme.status, 'bad nested theme_default → 400').toBe(400);
        expect(messages(theme.body)).toContain(
            'header.theme_default must be one of the following values: light, dark, system',
        );

        // import_max_rows @Max(2000): an over-cap value is rejected.
        const over = await putSettings(request, token, workId, { import_max_rows: 9999 });
        expect(over.status, 'import_max_rows>2000 → 400').toBe(400);
        expect(messages(over.body)).toContain('import_max_rows must not be greater than 2000');

        // A non-integer import_max_rows trips the full @Max/@Min/@IsInt chain.
        const notInt = await putSettings(request, token, workId, { import_max_rows: 'lots' });
        expect(notInt.status, 'non-int import_max_rows → 400').toBe(400);
        expect(messages(notInt.body)).toContain('import_max_rows must be an integer number');

        // company_name @MaxLength(100).
        const longName = await putSettings(request, token, workId, {
            company_name: 'a'.repeat(130),
        });
        expect(longName.status, 'company_name>100 → 400').toBe(400);
        expect(messages(longName.body)).toContain(
            'company_name must be shorter than or equal to 100 characters',
        );

        // homepage.default_view @MaxLength(20) — nested string cap.
        const longView = await putSettings(request, token, workId, {
            homepage: { default_view: 'x'.repeat(30) },
        });
        expect(longView.status, 'homepage.default_view>20 → 400').toBe(400);
        expect(messages(longView.body)).toContain(
            'homepage.default_view must be shorter than or equal to 20 characters',
        );

        // A flat boolean flag rejects a non-boolean value.
        const badBool = await putSettings(request, token, workId, { categories_enabled: 'yes' });
        expect(badBool.status, 'non-boolean categories_enabled → 400').toBe(400);
        expect(messages(badBool.body)).toContain('categories_enabled must be a boolean value');

        // None of these validation rejections is the git-gate envelope — they
        // short-circuit BEFORE the write path.
        for (const r of [theme, over, notInt, longName, longView, badBool]) {
            expect(r.body.error, 'validation rejection uses Bad Request').toBe('Bad Request');
            expect(r.body.message, 'validation rejection carries an array message').not.toBe(
                GIT_GATE_MESSAGE,
            );
        }
    });

    // ─── PUT custom_menu — the href-security guard (scheme + open-redirect) ─────
    test('PUT /works/:id/website-settings rejects a `javascript:` custom_menu path with the relative-or-http(s) guard (href sanitization)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'menu-js');
        // A javascript: scheme in a menu href is an XSS vector on the deployed
        // public site — the DTO @Matches gate rejects it before any write.
        const { status, body } = await putSettings(request, token, workId, {
            custom_menu: { header: [{ label: 'X', path: 'javascript:alert(1)' }] },
        });
        expect(status, 'javascript: menu path → 400 validation').toBe(400);
        expect(messages(body)).toContain(
            'custom_menu.header.0.path must be a relative path (starting with /) or an http(s):// URL',
        );
        // It is the VALIDATION envelope, not the git gate (validation runs first).
        expect(body.status, 'rejection is not the git-gate error envelope').not.toBe('error');
    });

    test('PUT /works/:id/website-settings rejects a protocol-relative `//evil.com` custom_menu path (open-redirect guard)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'menu-rel');
        // `//host` is protocol-relative — a browser treats it as an absolute
        // off-site URL. The single-leading-slash rule (`/(?!/)`) rejects it so a
        // stored menu link cannot silently retarget visitors off the directory.
        const { status, body } = await putSettings(request, token, workId, {
            custom_menu: { header: [{ label: 'X', path: '//evil.com' }] },
        });
        expect(status, 'protocol-relative menu path → 400 validation').toBe(400);
        expect(messages(body)).toContain(
            'custom_menu.header.0.path must be a relative path (starting with /) or an http(s):// URL',
        );
    });

    test('PUT /works/:id/website-settings rejects a bad custom_menu target enum and an over-long label', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'menu-enum');

        // target is an @IsIn(['_self','_blank']) — '_top' is rejected.
        const badTarget = await putSettings(request, token, workId, {
            custom_menu: { footer: [{ label: 'Y', path: '/y', target: '_top' }] },
        });
        expect(badTarget.status, 'bad target enum → 400').toBe(400);
        expect(messages(badTarget.body)).toContain(
            'custom_menu.footer.0.target must be one of the following values: _self, _blank',
        );

        // label is @MaxLength(50).
        const longLabel = await putSettings(request, token, workId, {
            custom_menu: { header: [{ label: 'L'.repeat(60), path: '/ok' }] },
        });
        expect(longLabel.status, 'over-long menu label → 400').toBe(400);
        expect(messages(longLabel.body)).toContain(
            'custom_menu.header.0.label must be shorter than or equal to 50 characters',
        );
    });

    // ─── PUT — a VALID custom_menu still hits the git gate (no round-trip in CI) ─
    test('PUT /works/:id/website-settings with a STRUCTURALLY-VALID custom_menu passes validation and hits the GIT GATE (typed 400)', async ({
        request,
    }) => {
        const { token, workId, name } = await ownerWithWork(request, 'menu-ok');
        // A relative `/home` path passes the @Matches gate, so validation does NOT
        // short-circuit; the write reaches the git-gated persist, which fails with
        // the typed reconnect-Git envelope on the repo-less CI stack.
        const put = await putSettings(request, token, workId, {
            custom_menu: { header: [{ label: 'Home', path: '/home', target: '_self' }] },
        });
        expect(put.status, `valid menu PUT is git-gated → 400; body=${put.text}`).toBe(400);
        expect(put.body.status, 'git-gate error envelope').toBe('error');
        expect(put.body.message, 'git-gate reconnect message').toBe(GIT_GATE_MESSAGE);

        // The write never landed — the GET still shows the seeded defaults.
        const after = await readBody(
            await request.get(`${API_BASE}/api/works/${workId}/website-settings`, {
                headers: authedHeaders(token),
            }),
        );
        expect(after.body.company_name, 'company_name unchanged after the gated menu write').toBe(
            name,
        );
        expect(after.body.custom_menu, 'custom_menu still empty after the gated write').toEqual({
            header: [],
            footer: [],
        });
    });

    // ─── PUT — an EMPTY body (all-optional) still hits the git gate ─────────────
    test('PUT /works/:id/website-settings with an EMPTY body {} passes validation (all fields optional) and still hits the GIT GATE', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'empty-body');
        // Every UpdateWebsiteSettingsDto field is @IsOptional, so an empty body is
        // VALID — there is nothing to short-circuit on, so the request flows into
        // the git-gated write and fails with the same typed envelope.
        const put = await putSettings(request, token, workId, {});
        expect(put.status, `empty-body PUT is git-gated → 400; body=${put.text}`).toBe(400);
        expect(put.body.status, 'git-gate error envelope').toBe('error');
        expect(put.body.message, 'git-gate reconnect message').toBe(GIT_GATE_MESSAGE);
    });

    // ─── PUT — foreign EDIT-access guard (distinct from the GET read guard) ─────
    test('PUT /works/:id/website-settings for a FOREIGN user → 403 (ensureCanEdit) and the owner GET is unchanged', async ({
        request,
    }) => {
        const { token, workId, name } = await ownerWithWork(request, 'put-foreign');
        const stranger = await registerUserViaAPI(request);

        // The write guard is ensureCanEdit (stricter than the GET's ensureCanView);
        // a non-owner is rejected with the permission envelope BEFORE the DTO is
        // even consulted, so a perfectly-valid body still 403s.
        const put = await putSettings(request, stranger.access_token, workId, {
            company_name: 'Hijack Co',
        });
        expect(put.status, 'foreign edit → 403').toBe(403);
        expect(put.body.status, 'foreign edit error envelope').toBe('error');
        expect(put.body.message, 'foreign edit permission message').toBe(NO_PERMISSION);

        // The owner's settings are intact — the rejected write was a no-op.
        const after = await readBody(
            await request.get(`${API_BASE}/api/works/${workId}/website-settings`, {
                headers: authedHeaders(token),
            }),
        );
        expect(after.status, 'owner settings still readable').toBe(200);
        expect(after.body.company_name, 'company_name untouched by the foreign write').toBe(name);
    });

    // ─── id resolution — works :id is NOT UUID-guarded (404, not a format 400) ──
    test('a MALFORMED (non-UUID) work id on /config and /website-settings → 404 not-found (the works :id is NOT ParseUUIDPipe-guarded)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const oh = authedHeaders(owner.access_token);

        // Unlike the templates/customizations route (ParseUUIDPipe → 400), the
        // works :id param is a free string: a non-UUID resolves to a clean
        // not-found, never a format-validation 400.
        for (const path of ['config', 'website-settings']) {
            const { status, body } = await readBody(
                await request.get(`${API_BASE}/api/works/not-a-uuid/${path}`, { headers: oh }),
            );
            expect(status, `malformed-id /${path} → 404 (not a 400 format error)`).toBe(404);
            expect(body.status, `malformed-id /${path} error envelope`).toBe('error');
            expect(body.message, `malformed-id /${path} names the id as not-found`).toBe(
                "Work with id 'not-a-uuid' not found",
            );
        }
    });

    // ─── nonexistent (well-formed) id on PUT website-settings → 404 ─────────────
    test('PUT /works/:id/website-settings on a NONEXISTENT (well-formed) work id → 404 (existence resolved before the git gate)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // A well-formed but absent id with a VALID body: the owner passes auth,
        // the work-not-found resolves to a 404 BEFORE the write path / git gate —
        // never the reconnect-Git message (which would imply the work existed).
        const { status, body } = await putSettings(request, owner.access_token, ZERO_UUID, {
            company_name: 'Ghost Co',
        });
        expect(status, 'nonexistent-id PUT → 404').toBe(404);
        expect(body.status, 'nonexistent-id error envelope').toBe('error');
        expect(body.message, 'nonexistent-id names the missing id').toBe(
            `Work with id '${ZERO_UUID}' not found`,
        );
        expect(body.message, 'a missing work never reaches the git gate').not.toBe(
            GIT_GATE_MESSAGE,
        );
    });
});
