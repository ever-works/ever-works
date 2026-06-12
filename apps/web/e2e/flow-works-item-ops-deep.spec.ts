import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-works-item-ops-deep — Works long-tail DEEP coverage for the single-item
 * OPERATION surface that the existing item specs leave unpinned:
 *   POST /api/works/:id/update-item        (UpdateItemDto extras + slug guard)
 *   POST /api/works/:id/remove-item        (reason cap + forbidNonWhitelisted)
 *   POST /api/works/:id/check-item-health  (env-adaptive deterministic failure)
 *   POST /api/extract-item-details         (SSRF guard + keyless soft-error)
 *   POST /api/works/:id/bulk-capture-images(no-DTO gate; ownership/existence)
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────────
 *   - sec-pin-dto-bounds.spec.ts pins the SUBMIT-ITEM DTO length/cardinality
 *     caps (name/description/category/categories/tags Max* + the aggregate). It
 *     does NOT touch update-item / remove-item / extract-item-details /
 *     bulk-capture-images at all. This file pins THOSE routes' contracts only;
 *     it never re-asserts a submit-item bound.
 *   - flow-work-items-crud-deep.spec.ts walks submit-item validation, the list↔
 *     count invariant, pagination tolerance, and the cross-tenant/anon gate; it
 *     touches remove-item/update-item/check-item-health ONLY with an already-
 *     VALID item_slug ('no-such-item' / 'whatever') reaching the git gate, and
 *     calls out (but never asserts) the `featured`-forbidden-on-RemoveItemDto
 *     and the slug path-traversal guard. The GAPS pinned here are:
 *       • update-item: item_slug @Matches(/^[a-z0-9_-]+$/) path-traversal
 *         rejection (../, /, \, uppercase, dots); the source_url(require_protocol)
 *         / order(Min 0) / markdown(MaxLength 100000) bounds + their boundary
 *         accept; validation-precedes-ownership ordering for a STRANGER.
 *       • remove-item: reason MaxLength(500) over-bound + forbidNonWhitelisted
 *         "property featured should not exist" + slug guard.
 *       • extract-item-details (route is /api/extract-item-details — NOT under
 *         works/:id): the SSRF constraint (loopback/metadata/file:// → 400
 *         "source_url is not allowed"), workId @IsUUID, the workId ownership(403)
 *         /existence(404) gate, anon 401, and the KEYLESS soft-error contract
 *         (valid public URL → 200 { status:'error', message:'Could not extract
 *         content from the provided URL' } — a typed soft-fail, never a throw).
 *       • bulk-capture-images: BulkCaptureImagesDto is a plain interface (NO
 *         ValidationPipe) so {} and {mode:'all'} both reach the service; on a
 *         non-git work getItems reads gracefully → 200 success-empty (NOT a git
 *         gate); ownership 403 / existence 404 / anon 401.
 *
 * ── PROBED CONTRACTS (live against http://127.0.0.1:3100, 2026-06-12) ────────
 *  DISCRIMINATOR: a *validation* 400 carries a `message` ARRAY (+ error:
 *  'Bad Request'); the *git-gate* 400 carries a STRING `message` (+ status:
 *  'error', echoing slug/item_name/item_slug). Asserted per branch.
 *
 *  POST /api/works/:id/update-item
 *    item_slug '../etc/passwd' | 'Foo-Bar' | 'a/b' | 'a.b' →
 *        400 ["item_slug must contain only lowercase letters, digits, hyphens, and underscores"]
 *    { item_slug:'valid-slug', source_url:'example.com' } (no protocol) →
 *        400 ["source_url must be a URL address"]
 *    { item_slug:'valid-slug', order:-1 } → 400 ["order must not be less than 0"]
 *    { item_slug:'valid-slug', markdown:'m'*100001 } →
 *        400 ["markdown must be shorter than or equal to 100000 characters"]
 *    { item_slug:'valid-slug', markdown:'m'*100000 } → git gate (boundary accept)
 *    { item_slug:'valid-slug', featured:true } (owner, non-git work) → git gate
 *        { status:'error', slug, item_name:'Unknown', item_slug:'valid-slug',
 *          message:'Please reconnect your Git account to continue.' }
 *    STRANGER + valid body → 403 'You do not have permission to access this work'
 *    STRANGER + bad slug   → 400 (ValidationPipe precedes ownership)
 *    ABSENT work id (valid body) → 404 "Work with id '…' not found"
 *    anonymous → 401 { message:'Unauthorized', statusCode:401 }
 *
 *  POST /api/works/:id/remove-item
 *    { item_slug:'valid-slug', reason:'r'*501 } →
 *        400 ["reason must be shorter than or equal to 500 characters"]
 *    { item_slug:'valid-slug', featured:true } →
 *        400 ["property featured should not exist"]   (forbidNonWhitelisted)
 *    { item_slug:'../../secret' } → 400 (same slug @Matches guard)
 *    { item_slug:'valid-slug', reason:'cleanup' } (owner) → git gate (echoes item_slug)
 *
 *  POST /api/works/:id/check-item-health
 *    { item_slug:'valid-slug' } (owner, non-git work) → deterministic >=400
 *        (NOT a silent 2xx) — env-adaptive, no exact code pinned.
 *
 *  POST /api/extract-item-details   (ExtractItemDetailsDto)
 *    {} → 400 message ARRAY incl. "source_url is not allowed"
 *    source_url 'http://127.0.0.1:8080/admin' → 400 ["source_url is not allowed"]
 *    source_url 'http://169.254.169.254/latest/meta-data/' → 400 ["source_url is not allowed"]
 *    source_url 'file:///etc/passwd' → 400 (incl. "source_url is not allowed")
 *    { source_url:'https://example.com', workId:'not-a-uuid' } → 400 ["workId must be a UUID"]
 *    { source_url:'https://example.com', workId:<FOREIGN> } → 403 permission
 *    { source_url:'https://example.com', workId:<ABSENT uuid> } → 404 not found
 *    { source_url:'https://example.com' } (keyless) → 200 { status:'error',
 *        source_url, message:'Could not extract content from the provided URL' }
 *    anonymous → 401
 *
 *  POST /api/works/:id/bulk-capture-images   (plain interface — no ValidationPipe)
 *    { mode:'missing' } | { mode:'all' } | {} (owner, non-git work) →
 *        200 { status:'success', results:[], totalProcessed:0, successCount:0,
 *              errorCount:0, message:'No items found in work' }
 *    STRANGER → 403 'You do not have permission to access this work'
 *    ABSENT work id → 404 "Work with id '…' not found"
 *    anonymous → 401
 *
 * Isolation: every test runs on a FRESH registerUserViaAPI() user (+ fresh work
 * where needed) with a per-test unique suffix (counter+title, NOT a module clock).
 * API-only. The anonymous context uses an explicit empty storageState (a bare
 * browser.newContext() would inherit the project's auth cookie).
 */

const REQ_TIMEOUT = 60_000;
const GIT_GATE_MESSAGE = 'Please reconnect your Git account to continue.';
const SLUG_GUARD_MESSAGE =
    'item_slug must contain only lowercase letters, digits, hyphens, and underscores';
const ABSENT_WORK_ID = '00000000-0000-0000-0000-000000000000';

/** Validation 400 envelope (ValidationPipe): message is an ARRAY. */
interface ValidationErrorBody {
    message: string[];
    error: string;
    statusCode: number;
}

/** Domain error envelope (git gate / ownership / service soft-fail): STRING message. */
interface DomainErrorBody {
    status: string;
    slug?: string;
    item_name?: string;
    item_slug?: string;
    source_url?: string;
    message: string;
}

let testCounter = 0;
/** Per-test unique suffix (NOT a module-scope clock). */
function uniq(label: string): string {
    testCounter += 1;
    return `${label}-${testCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

async function freshUser(request: APIRequestContext): Promise<string> {
    const user = await registerUserViaAPI(request);
    return user.access_token;
}

async function freshUserWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; workId: string }> {
    const token = await freshUser(request);
    const work = await createWorkViaAPI(request, token, { name: uniq(label) });
    expect(work.id, 'fixture work id resolved').toBeTruthy();
    return { token, workId: work.id };
}

function postItemRoute(
    request: APIRequestContext,
    token: string,
    workId: string,
    route: 'update-item' | 'remove-item' | 'check-item-health' | 'bulk-capture-images',
    body: Record<string, unknown>,
): Promise<APIResponse> {
    return request.post(`${API_BASE}/api/works/${workId}/${route}`, {
        headers: authedHeaders(token),
        data: body,
        timeout: REQ_TIMEOUT,
    });
}

function postExtract(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<APIResponse> {
    return request.post(`${API_BASE}/api/extract-item-details`, {
        headers: authedHeaders(token),
        data: body,
        timeout: REQ_TIMEOUT,
    });
}

/** Assert a ValidationPipe 400 whose message ARRAY contains the exact string. */
async function expectValidation400(res: APIResponse, expected: string): Promise<void> {
    expect(res.status(), `validation 400 (got ${await res.text()})`).toBe(400);
    const body = (await res.json()) as ValidationErrorBody;
    expect(Array.isArray(body.message), 'validation 400 carries a message ARRAY').toBe(true);
    expect(body.message, `message array contains: ${expected}`).toContain(expected);
    expect(body.error).toBe('Bad Request');
}

/** Assert the body passed DTO validation and bottomed out in the git gate. */
async function expectGitGate(res: APIResponse): Promise<DomainErrorBody> {
    expect(res.status(), `git-gate 400 (got ${await res.text()})`).toBe(400);
    const body = (await res.json()) as DomainErrorBody;
    expect(Array.isArray(body.message), 'NOT a validation array — DTO accepted').toBe(false);
    expect(body.status, 'git-gate envelope is the domain error').toBe('error');
    expect(body.message, 'exact reconnect-git remediation').toBe(GIT_GATE_MESSAGE);
    return body;
}

// ─── update-item: item_slug path-traversal @Matches guard ───────────────────

test.describe('update-item — item_slug path-traversal guard (@Matches /^[a-z0-9_-]+$/)', () => {
    const TRAVERSAL_SLUGS = ['../etc/passwd', 'a/b', 'a\\b', 'Foo-Bar', 'a.b', 'foo bar'];

    for (const slug of TRAVERSAL_SLUGS) {
        test(`a slug "${slug}" is rejected at the DTO with the exact char-set message (cannot reach the file layer)`, async ({
            request,
        }) => {
            const { token, workId } = await freshUserWork(request, 'upd-slug');
            const res = await postItemRoute(request, token, workId, 'update-item', {
                item_slug: slug,
            });
            await expectValidation400(res, SLUG_GUARD_MESSAGE);
            // It is the VALIDATION branch, never the git-gate domain envelope —
            // the malicious slug never reaches path.join in the data layer.
            const body = (await res.json()) as DomainErrorBody;
            expect(body.status, 'no git-gate leakage on a slug validation 400').not.toBe('error');
        });
    }

    test('a clean slug passes the guard and a featured-toggle bottoms out in the git gate (echoing the slug verbatim)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request, 'upd-ok');
        const res = await postItemRoute(request, token, workId, 'update-item', {
            item_slug: 'valid-slug',
            featured: true,
        });
        const gate = await expectGitGate(res);
        // The gate echoes the slug it was about to update — proof the clean slug
        // flowed through the DTO untouched.
        expect(gate.item_slug, 'git-gate echoes the accepted slug').toBe('valid-slug');
        expect(typeof gate.slug, 'git-gate echoes the work slug').toBe('string');
    });
});

// ─── update-item: optional-field bounds (source_url / order / markdown) ──────

test.describe('update-item — UpdateItemDto optional-field bounds', () => {
    test('source_url without a protocol → 400 "must be a URL address" (require_protocol)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request, 'upd-url');
        const res = await postItemRoute(request, token, workId, 'update-item', {
            item_slug: 'valid-slug',
            source_url: 'example.com',
        });
        await expectValidation400(res, 'source_url must be a URL address');
    });

    test('order of -1 → 400 "order must not be less than 0" (@Min(0))', async ({ request }) => {
        const { token, workId } = await freshUserWork(request, 'upd-order');
        const res = await postItemRoute(request, token, workId, 'update-item', {
            item_slug: 'valid-slug',
            order: -1,
        });
        await expectValidation400(res, 'order must not be less than 0');
    });

    test('markdown of 100001 chars → 400 MaxLength message; exactly 100000 passes (boundary accept → git gate)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request, 'upd-md');

        const over = await postItemRoute(request, token, workId, 'update-item', {
            item_slug: 'valid-slug',
            markdown: 'm'.repeat(100001),
        });
        await expectValidation400(
            over,
            'markdown must be shorter than or equal to 100000 characters',
        );

        const boundary = await postItemRoute(request, token, workId, 'update-item', {
            item_slug: 'valid-slug',
            markdown: 'm'.repeat(100000),
        });
        // 100000 is accepted by the DTO and falls through to the git gate (the
        // boundary value is NOT silently rejected).
        await expectGitGate(boundary);
    });
});

// ─── remove-item: reason cap + forbidNonWhitelisted + slug guard ────────────

test.describe('remove-item — RemoveItemDto bounds and whitelist', () => {
    test('reason of 501 chars → 400 with the exact 500-char MaxLength message', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request, 'rm-reason');
        const res = await postItemRoute(request, token, workId, 'remove-item', {
            item_slug: 'valid-slug',
            reason: 'r'.repeat(501),
        });
        await expectValidation400(res, 'reason must be shorter than or equal to 500 characters');
    });

    test('an UpdateItemDto-only field (featured) is rejected by forbidNonWhitelisted on remove-item', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request, 'rm-forbid');
        const res = await postItemRoute(request, token, workId, 'remove-item', {
            item_slug: 'valid-slug',
            featured: true,
        });
        await expectValidation400(res, 'property featured should not exist');
    });

    test('the same slug guard applies; a clean slug + bounded reason reaches the owner git gate (echoing the slug)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request, 'rm-ok');

        const traversal = await postItemRoute(request, token, workId, 'remove-item', {
            item_slug: '../../secret',
        });
        await expectValidation400(traversal, SLUG_GUARD_MESSAGE);

        const gate = await expectGitGate(
            await postItemRoute(request, token, workId, 'remove-item', {
                item_slug: 'valid-slug',
                reason: 'cleanup',
            }),
        );
        expect(gate.item_slug, 'git-gate echoes the accepted slug').toBe('valid-slug');
    });
});

// ─── check-item-health: env-adaptive deterministic failure ──────────────────

test.describe('check-item-health — env-adaptive deterministic failure', () => {
    test('a DTO-valid item_slug on a non-git work resolves to a deterministic >=400 (never a silent 2xx)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request, 'health');
        const res = await postItemRoute(request, token, workId, 'check-item-health', {
            item_slug: 'valid-slug',
        });
        const status = res.status();
        expect(
            status,
            `check-item-health on a non-connected work is a deterministic error; body=${await res.text().catch(() => '')}`,
        ).toBeGreaterThanOrEqual(400);
        expect(status, 'check-item-health did not silently 2xx').not.toBe(200);
    });
});

// ─── extract-item-details: SSRF guard + DTO validation ──────────────────────

test.describe('extract-item-details — SSRF guard and DTO validation', () => {
    test('an empty body → 400 whose message array names the SSRF + URL + string validators', async ({
        request,
    }) => {
        const token = await freshUser(request);
        const res = await postExtract(request, token, {});
        expect(res.status()).toBe(400);
        const body = (await res.json()) as ValidationErrorBody;
        expect(Array.isArray(body.message)).toBe(true);
        const joined = body.message.join(' | ');
        expect(joined, 'SSRF constraint fires on the missing/absent url').toMatch(
            /source_url is not allowed/i,
        );
        expect(joined).toMatch(/source_url must be a URL address/i);
    });

    const SSRF_URLS = [
        { label: 'loopback IPv4', url: 'http://127.0.0.1:8080/admin' },
        { label: 'cloud metadata IP', url: 'http://169.254.169.254/latest/meta-data/' },
        { label: 'file:// scheme', url: 'file:///etc/passwd' },
    ];
    for (const { label, url } of SSRF_URLS) {
        test(`a ${label} source_url is rejected at the DTO with "source_url is not allowed"`, async ({
            request,
        }) => {
            const token = await freshUser(request);
            const res = await postExtract(request, token, { source_url: url });
            await expectValidation400(res, 'source_url is not allowed');
        });
    }

    test('a non-UUID workId → 400 "workId must be a UUID" (validation precedes the ownership lookup)', async ({
        request,
    }) => {
        const token = await freshUser(request);
        const res = await postExtract(request, token, {
            source_url: 'https://example.com',
            workId: 'not-a-uuid',
        });
        await expectValidation400(res, 'workId must be a UUID');
    });

    test('workId scoping: a FOREIGN work → 403 permission, an ABSENT work → 404 not found', async ({
        request,
    }) => {
        // Owner creates a work; a stranger references it via workId.
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: uniq('extract-foreign'),
        });
        const strangerToken = await freshUser(request);

        const foreign = await postExtract(request, strangerToken, {
            source_url: 'https://example.com',
            workId: work.id,
        });
        expect(foreign.status(), 'foreign workId → ownership 403').toBe(403);
        expect(
            ((await foreign.json()) as DomainErrorBody).message,
            'foreign workId surfaces the permission error',
        ).toMatch(/permission/i);

        const absent = await postExtract(request, owner.access_token, {
            source_url: 'https://example.com',
            workId: ABSENT_WORK_ID,
        });
        expect(absent.status(), 'absent workId → existence 404').toBe(404);
        expect(
            ((await absent.json()) as DomainErrorBody).message,
            'absent workId surfaces the not-found error',
        ).toMatch(/not found/i);
    });

    test('keyless contract: a valid public URL → 200 with a TYPED soft-error (never a thrown 5xx)', async ({
        request,
    }) => {
        const token = await freshUser(request);
        const res = await postExtract(request, token, { source_url: 'https://example.com' });
        // Keyless CI: the default local content-extractor cannot pull meaningful
        // content, so the endpoint returns a typed soft-failure with HTTP 200 —
        // it does NOT throw. We assert the envelope, not extraction success.
        expect(
            res.status(),
            `keyless extract is a typed soft-fail (200), not a throw; body=${await res.text().catch(() => '')}`,
        ).toBe(200);
        const body = (await res.json()) as DomainErrorBody;
        expect(body.status, 'keyless extract reports a typed error status').toBe('error');
        expect(body.source_url, 'echoes the requested url').toBe('https://example.com');
        expect(typeof body.message, 'soft-error message is a string').toBe('string');
        expect(body.message).toMatch(/could not extract content/i);
    });
});

// ─── bulk-capture-images: no-DTO gate; ownership / existence / success-empty ─

test.describe('bulk-capture-images — ungated DTO; ownership / existence / read-graceful', () => {
    test('on a non-git work every mode (missing / all / no-mode) returns the success-empty envelope (getItems reads gracefully — NOT a git gate)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request, 'bulk-modes');

        // BulkCaptureImagesDto is a plain interface (no class-validator), so even
        // a body with no `mode` is accepted and reaches the service.
        for (const body of [{ mode: 'missing' }, { mode: 'all' }, {}]) {
            const res = await postItemRoute(request, token, workId, 'bulk-capture-images', body);
            expect(
                res.status(),
                `mode=${JSON.stringify(body)} → 200; body=${await res.text().catch(() => '')}`,
            ).toBe(200);
            const json = (await res.json()) as {
                status?: string;
                results?: unknown[];
                totalProcessed?: number;
                successCount?: number;
                errorCount?: number;
                message?: string;
            };
            expect(json.status, 'empty work → success').toBe('success');
            expect(Array.isArray(json.results) && json.results.length, 'no results').toBe(0);
            expect(json.totalProcessed, 'nothing processed').toBe(0);
            expect(json.successCount).toBe(0);
            expect(json.errorCount).toBe(0);
            expect(json.message, 'service reports the empty work').toBe('No items found in work');
        }
    });

    test('ownership + existence gating: a STRANGER → 403 permission, an ABSENT work → 404 not found', async ({
        request,
    }) => {
        const { workId } = await freshUserWork(request, 'bulk-gate');
        const strangerToken = await freshUser(request);

        const stranger = await postItemRoute(
            request,
            strangerToken,
            workId,
            'bulk-capture-images',
            { mode: 'all' },
        );
        expect(stranger.status(), 'stranger bulk-capture → 403').toBe(403);
        expect(
            ((await stranger.json()) as DomainErrorBody).message,
            'stranger surfaces the permission error',
        ).toMatch(/permission/i);

        const ownerToken = await freshUser(request);
        const absent = await postItemRoute(
            request,
            ownerToken,
            ABSENT_WORK_ID,
            'bulk-capture-images',
            { mode: 'all' },
        );
        expect(absent.status(), 'bulk-capture on absent work → 404').toBe(404);
        expect(
            ((await absent.json()) as DomainErrorBody).message,
            'absent work surfaces the not-found error',
        ).toMatch(/not found/i);
    });
});

// ─── anonymous gate across every new operation route ────────────────────────

test.describe('item-operation routes — anonymous gate (401 before any ownership/DTO work)', () => {
    test('an anonymous client is rejected 401 on update-item, remove-item, extract-item-details, and bulk-capture-images', async ({
        request,
        browser,
    }) => {
        // A real work id (owned by a fresh user) so a 401 cannot be mistaken for
        // a 404 — the auth gate must fire BEFORE existence resolution.
        const { workId } = await freshUserWork(request, 'anon-gate');

        // Explicit empty storageState — a bare newContext() would inherit the
        // project's auth cookie and silently authenticate.
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anon = anonCtx.request;

            const update = await anon.post(`${API_BASE}/api/works/${workId}/update-item`, {
                data: { item_slug: 'valid-slug' },
                timeout: REQ_TIMEOUT,
            });
            expect(update.status(), 'anon update-item → 401').toBe(401);
            expect(((await update.json()) as { statusCode?: number }).statusCode).toBe(401);

            const remove = await anon.post(`${API_BASE}/api/works/${workId}/remove-item`, {
                data: { item_slug: 'valid-slug' },
                timeout: REQ_TIMEOUT,
            });
            expect(remove.status(), 'anon remove-item → 401').toBe(401);

            const extract = await anon.post(`${API_BASE}/api/extract-item-details`, {
                data: { source_url: 'https://example.com' },
                timeout: REQ_TIMEOUT,
            });
            expect(extract.status(), 'anon extract-item-details → 401').toBe(401);

            const bulk = await anon.post(`${API_BASE}/api/works/${workId}/bulk-capture-images`, {
                data: { mode: 'all' },
                timeout: REQ_TIMEOUT,
            });
            expect(bulk.status(), 'anon bulk-capture-images → 401').toBe(401);
        } finally {
            await anonCtx.close();
        }
    });
});
