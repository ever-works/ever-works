import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-items-crud-deep — the DEEP, contract-precise companion to
 * `work-items-crud.spec.ts` (shallow auth-gate + read-shape smoke) and
 * `items-import-export.spec.ts` (CSV/Excel bulk import/export route gating).
 *
 * This file exercises the SINGLE-ITEM sub-resource as multi-step INTEGRATION
 * flows: create a Work, then walk the submit-item DTO validation matrix, the
 * git-gated write branch (the precise "reconnect your Git account" boundary),
 * the list↔count reflection invariant, pagination/filter query tolerance, and
 * cross-tenant + anonymous isolation. None of these are covered as a deep flow
 * by the existing work-* / works-* / items-* specs.
 *
 * ── EXACT CONTRACT, PROBED LIVE AGAINST http://127.0.0.1:3100 BEFORE WRITING ──
 * (every shape/status/message below was confirmed via curl on a freshly
 *  registered user + freshly created, NON-git-connected work)
 *
 *  GET  /api/works/:id/items
 *       200 { status:'success', items:[] }                      (fresh work: empty)
 *       tolerates ?page=&limit=&search=&category=&sort= (and page=-1) → still 200
 *  GET  /api/works/:id/count
 *       200 { status:'success', items:0, categories:0, tags:0 } (workCount())
 *  GET  /api/works/:id/categories-tags
 *       200 { status:'success', categories:[], tags:[], collections:[] }
 *
 *  POST /api/works/:id/submit-item   (DTO: SubmitItemDto — submit-item.dto.ts)
 *       name        @IsString @IsNotEmpty
 *       description @IsString @IsNotEmpty        (REQUIRED — easy to miss)
 *       source_url  @IsString @IsUrl             (no @IsNotEmpty → never "should not be empty")
 *       category?   @IsString @IsNotEmpty        (required IF categories is empty/absent)
 *       categories? @IsArray @ArrayMinSize(1) @IsString({each})  (required IF no category)
 *    DTO validation (ValidationPipe) runs BEFORE the ownership/git checks → 400
 *       { message:[<class-validator strings>], error:'Bad Request', statusCode:400 }
 *       PROBED strings: "name should not be empty", "name must be a string",
 *                       "description should not be empty",
 *                       "source_url must be a URL address", "source_url must be a string",
 *                       "category should not be empty",
 *                       "each value in categories must be a string",
 *                       "categories must contain at least 1 elements"
 *    A DTO-VALID body on a NON-git-connected work → the GIT GATE → 400
 *       { status:'error', slug, item_name, message:'Please reconnect your Git account to continue.' }
 *
 *  POST /api/works/:id/remove-item / update-item / check-item-health
 *       DTO: each requires item_slug @IsString @IsNotEmpty → empty {} → validation 400
 *            (message array: "item_slug should not be empty" / "item_slug must be a string").
 *       A DTO-VALID body (item_slug present) by the OWNER on a non-connected work (PROBED):
 *            remove-item / update-item → 400 git-gate
 *               { status:'error', slug, item_name, item_slug, message:GIT_GATE_MESSAGE }
 *            check-item-health         → 500 (the source-validation path has no repo to
 *               read) — a deterministic server error, NOT the git-gate 400 envelope.
 *       The same DTO-VALID body by a STRANGER → 403 permission (ownership beats the git
 *            layer for a non-owner). So OWNER sees the git/server error, STRANGER sees 403.
 *
 *  AUTH / OWNERSHIP ordering (PROBED):
 *    anonymous (no bearer)            → 401 { message:'Unauthorized', statusCode:401 }
 *    a different authenticated user:
 *       GET item routes              → 403 { status:'error',
 *                                            message:'You do not have permission to access this work' }
 *       POST submit-item (DTO-VALID) → 403 (ownership beats the git gate for a stranger)
 *       POST remove-item (DTO-VALID) → 403 (likewise)
 *       POST submit-item (DTO-INVALID) → 400 (ValidationPipe beats ownership)
 *
 *  DISCRIMINATOR used throughout: a *validation* 400 carries a `message` ARRAY
 *  (+ error:'Bad Request'); the *ownership/git* response carries a `message`
 *  STRING (+ status:'error'). The flows assert the right branch each time.
 *
 * GOTCHAS honoured: login DTO is {email,password} only (we never POST it here —
 * we use registerUserViaAPI tokens); item WRITES are git-gated (we assert the
 * EXACT gate, never a fictional 2xx); cross-spec isolation → every flow runs on
 * FRESH registerUserViaAPI() users with Date.now()-suffixed names; a bare
 * browser.newContext() inherits the storageState cookie, so the anon context
 * passes an explicit empty storageState; resilient generous timeouts + poll.
 */

const REQ_TIMEOUT = 20_000;
const ABSENT_WORK_ID = '00000000-0000-0000-0000-000000000000';
const GIT_GATE_MESSAGE = 'Please reconnect your Git account to continue.';

async function getJson(request: APIRequestContext, token: string, path: string) {
    return request.get(`${API_BASE}${path}`, {
        headers: authedHeaders(token),
        timeout: REQ_TIMEOUT,
    });
}

async function postItem(
    request: APIRequestContext,
    token: string,
    workId: string,
    body: Record<string, unknown>,
    route = 'submit-item',
) {
    return request.post(`${API_BASE}/api/works/${workId}/${route}`, {
        headers: authedHeaders(token),
        data: body,
        timeout: REQ_TIMEOUT,
    });
}

/** Read the items list from the `{status,items}` envelope (assert envelope too). */
async function readItemsEnvelope(res: { status(): number; json(): Promise<unknown> }) {
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status?: string; items?: unknown[] };
    expect(body.status, 'items envelope is success').toBe('success');
    expect(Array.isArray(body.items), 'items is an array').toBe(true);
    return body.items as unknown[];
}

test.describe('Work items CRUD — deep single-item lifecycle (API integration)', () => {
    test('list contract: items/count/categories-tags envelopes agree that a fresh work is empty', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `e2e-items-list-${Date.now()}`,
        });
        expect(work.id, 'work id resolved from create response').toBeTruthy();

        // /items → { status:'success', items:[] }
        const items = await readItemsEnvelope(
            await getJson(request, token, `/api/works/${work.id}/items`),
        );
        expect(items.length, 'a freshly-created work starts with zero items').toBe(0);

        // /count → { status:'success', items:0, categories:0, tags:0 } — and the
        // count.items MUST reflect the empty list (the list↔count invariant).
        const countRes = await getJson(request, token, `/api/works/${work.id}/count`);
        expect(countRes.status()).toBe(200);
        const count = (await countRes.json()) as {
            status?: string;
            items?: number;
            categories?: number;
            tags?: number;
        };
        expect(count.status, 'count envelope is success').toBe('success');
        expect(count.items, 'count.items mirrors the empty items list').toBe(items.length);
        expect(count.items).toBe(0);
        expect(count.categories, 'fresh work has no categories').toBe(0);
        expect(count.tags, 'fresh work has no tags').toBe(0);

        // /categories-tags → { status:'success', categories:[], tags:[], collections:[] }
        const ctRes = await getJson(request, token, `/api/works/${work.id}/categories-tags`);
        expect(ctRes.status()).toBe(200);
        const ct = (await ctRes.json()) as {
            status?: string;
            categories?: unknown[];
            tags?: unknown[];
            collections?: unknown[];
        };
        expect(ct.status, 'categories-tags envelope is success').toBe('success');
        expect(Array.isArray(ct.categories) && ct.categories.length, 'no categories yet').toBe(0);
        expect(Array.isArray(ct.tags) && ct.tags.length, 'no tags yet').toBe(0);
        expect(Array.isArray(ct.collections), 'collections is an array').toBe(true);
    });

    test('submit-item DTO validation: name & source_url are required + typed, and validation precedes the git gate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `e2e-items-dto-${Date.now()}`,
        });

        // Each malformed body is rejected by the ValidationPipe with a 400 whose
        // `message` is an ARRAY of class-validator strings (the validation branch —
        // NOT the git-gate string branch). We assert the EXACT probed messages.
        // PROBED message arrays (live): each malformed body fails several validators
        // at once. We assert the load-bearing one(s) per case appear in the array.
        const cases: Array<{ label: string; body: Record<string, unknown>; expect: RegExp[] }> = [
            {
                label: 'empty object → name + description + source_url all required/typed',
                body: {},
                expect: [
                    /name should not be empty/i,
                    /description should not be empty/i,
                    /source_url must be a URL address/i,
                ],
            },
            {
                label: 'name only → description + source_url + category/categories still required',
                body: { name: 'No URL item' },
                expect: [/description should not be empty/i, /source_url must be a URL address/i],
            },
            {
                label: 'source_url only → name + description required',
                body: { source_url: 'https://example.com/a' },
                expect: [/name should not be empty/i, /description should not be empty/i],
            },
            {
                label: 'malformed source_url → must be a URL address',
                body: { name: 'Bad URL', description: 'd', source_url: 'not a url', category: 'x' },
                expect: [/source_url must be a URL address/i],
            },
            {
                // PROBED: a bare string for `categories` fails @IsArray/@ArrayMinSize
                // (and falls back to the category branch) — it does NOT emit the
                // each-value message because `@IsString({ each:true })` only runs over
                // arrays. To exercise the each-value validator we must pass an ARRAY
                // holding a non-string element ([123] → "each value in categories must
                // be a string", confirmed live).
                label: 'wrong-typed categories → each value must be a string',
                body: {
                    name: 'X',
                    description: 'd',
                    source_url: 'https://example.com/a',
                    categories: [123],
                },
                expect: [/each value in categories must be a string/i],
            },
        ];

        for (const c of cases) {
            const res = await postItem(request, token, work.id, c.body);
            const text = await res.text().catch(() => '');
            expect(res.status(), `${c.label}: validation 400 — body=${text}`).toBe(400);
            const body = JSON.parse(text) as { message?: unknown; error?: string; status?: string };
            // Validation branch discriminator: a string[] message + 'Bad Request'.
            expect(Array.isArray(body.message), `${c.label}: validation message is an array`).toBe(
                true,
            );
            expect(body.error, `${c.label}: validation error label`).toBe('Bad Request');
            const joined = (body.message as string[]).join(' | ');
            for (const rx of c.expect) {
                expect(joined, `${c.label}: expected message ${rx} in "${joined}"`).toMatch(rx);
            }
            // It is NOT the git-gate branch (that one is a string message + status:error).
            expect(body.status, `${c.label}: not the git-gate envelope`).not.toBe('error');
        }

        // All rejected at the DTO layer → nothing was written; the work is empty.
        const items = await readItemsEnvelope(
            await getJson(request, token, `/api/works/${work.id}/items`),
        );
        expect(items.length, 'rejected submits leave the work empty').toBe(0);
    });

    test('git-gated write: a fully-valid submit-item on a non-connected work hits the exact "reconnect your Git account" 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `e2e-items-gitgate-${Date.now()}`,
        });

        // Fully valid against SubmitItemDto: name + source_url + category +
        // categories[] (+ description). It PASSES validation, then bottoms out in
        // the git gate because the work has no connected/cloned git data repo.
        const validBody = {
            name: `Deep item ${Date.now()}`,
            source_url: 'https://example.com/deep-item',
            category: 'tools',
            categories: ['tools', 'ai'],
            description: 'submitted by flow-work-items-crud-deep',
        };

        const res = await postItem(request, token, work.id, validBody);
        const text = await res.text().catch(() => '');
        expect(res.status(), `git-gated submit-item → 400; body=${text}`).toBe(400);
        const body = JSON.parse(text) as {
            status?: string;
            message?: unknown;
            slug?: string;
            item_name?: string;
        };
        // Git-gate branch discriminator: status:'error' + a STRING message that is
        // the exact reconnect-git remediation (NOT a class-validator array). The
        // gate also echoes the work slug + the item_name it was about to write.
        expect(body.status, 'git-gate envelope is error').toBe('error');
        expect(typeof body.message, 'git-gate message is a single string').toBe('string');
        expect(body.message, 'exact reconnect-git message').toBe(GIT_GATE_MESSAGE);
        expect(body.item_name, 'git-gate echoes the item_name it was about to write').toBe(
            validBody.name,
        );
        expect(typeof body.slug, 'git-gate echoes the work slug').toBe('string');

        // The gated write committed NOTHING: list + count still agree on empty.
        const items = await readItemsEnvelope(
            await getJson(request, token, `/api/works/${work.id}/items`),
        );
        expect(items.length, 'a git-gated submit committed nothing').toBe(0);
        const countRes = await getJson(request, token, `/api/works/${work.id}/count`);
        expect(countRes.status()).toBe(200);
        expect(((await countRes.json()) as { items?: number }).items, 'count still 0').toBe(0);
    });

    test('remove-item & update-item: item_slug DTO gate THEN the owner-side git gate; check-item-health bottoms out in a deterministic server error', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `e2e-items-mutate-${Date.now()}`,
        });

        // PROBED two-stage contract for the git-routed item mutators:
        //   stage A — empty {} fails the item_slug DTO (item_slug @IsString @IsNotEmpty)
        //             → 400 validation array (NOT the git-gate string branch).
        //   stage B — a DTO-VALID body (item_slug present) by the OWNER reaches
        //             workGenerationService and hits the SAME git gate as submit-item
        //             → 400 { status:'error', message:GIT_GATE_MESSAGE }. It is the
        //             OWNER, so this is the git gate, NOT a permission 403.
        for (const route of ['remove-item', 'update-item'] as const) {
            // stage A: validation 400 on the missing item_slug.
            const invalid = await postItem(request, token, work.id, {}, route);
            const invalidText = await invalid.text().catch(() => '');
            expect(
                invalid.status(),
                `${route}: empty body → validation 400; body=${invalidText}`,
            ).toBe(400);
            const invalidBody = JSON.parse(invalidText) as { message?: unknown; error?: string };
            expect(
                Array.isArray(invalidBody.message),
                `${route}: validation message is an array`,
            ).toBe(true);
            expect(invalidBody.error, `${route}: Bad Request label`).toBe('Bad Request');
            expect(
                (invalidBody.message as string[]).join(' | '),
                `${route}: item_slug is the missing field`,
            ).toMatch(/item_slug/i);

            // stage B: DTO-valid body → owner reaches the git gate → exact 400.
            // PROBED: `featured` is whitelisted on UpdateItemDto but FORBIDDEN on
            // RemoveItemDto (forbidNonWhitelisted → "property featured should not
            // exist"), so the shared-valid body is item_slug ALONE — that bottoms
            // out in the git gate on BOTH routes (status:'error' + GIT_GATE_MESSAGE).
            const valid = await postItem(
                request,
                token,
                work.id,
                { item_slug: 'no-such-item' },
                route,
            );
            const validText = await valid.text().catch(() => '');
            expect(
                valid.status(),
                `${route}: DTO-valid body on non-connected work → git-gate 400; body=${validText}`,
            ).toBe(400);
            const validBody = JSON.parse(validText) as { status?: string; message?: unknown };
            expect(validBody.status, `${route}: git-gate error envelope`).toBe('error');
            expect(validBody.message, `${route}: exact reconnect-git message`).toBe(
                GIT_GATE_MESSAGE,
            );
        }

        // check-item-health is the diagnostic sibling: empty {} → item_slug
        // validation 400; a DTO-valid item_slug on a non-connected work resolves to
        // a deterministic server error (PROBED 500 — the source-validation path has
        // no repo to read). We assert the two-stage shape WITHOUT pinning the exact
        // server-error code (it is not the git-gate's 400 envelope here).
        const healthInvalid = await postItem(request, token, work.id, {}, 'check-item-health');
        expect(healthInvalid.status(), 'check-item-health empty body → validation 400').toBe(400);
        const healthInvalidBody = (await healthInvalid.json()) as { message?: unknown };
        expect(
            Array.isArray(healthInvalidBody.message),
            'check-item-health validation message is an array',
        ).toBe(true);

        const healthValid = await postItem(
            request,
            token,
            work.id,
            { item_slug: 'no-such-item' },
            'check-item-health',
        );
        expect(
            healthValid.status(),
            `check-item-health DTO-valid on non-connected work → deterministic error (>=400); body=${await healthValid.text().catch(() => '')}`,
        ).toBeGreaterThanOrEqual(400);
        expect(healthValid.status(), 'check-item-health did not silently 2xx').not.toBe(200);

        // The read surface is untouched by the rejected mutations.
        const items = await readItemsEnvelope(
            await getJson(request, token, `/api/works/${work.id}/items`),
        );
        expect(items.length).toBe(0);
    });

    test('pagination & filter tolerance: the items list accepts page/limit/search/sort params, never 5xx, always a stable empty array', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `e2e-items-page-${Date.now()}`,
        });

        // The list endpoint tolerates the usual pagination/filter query matrix
        // (probed: it 200s and returns the empty envelope regardless). Never 5xx,
        // never auth-denied for the owner, always the success envelope with [].
        const queries = [
            '',
            '?page=1&limit=10',
            '?page=2&limit=5',
            '?limit=0',
            '?limit=99999',
            '?page=-1',
            '?search=nonexistent-term-zzz',
            '?category=tools',
            '?sort=createdAt&order=desc',
            '?garbage=param&foo=bar',
        ];

        for (const q of queries) {
            const res = await getJson(request, token, `/api/works/${work.id}/items${q}`);
            const status = res.status();
            const text = await res.text().catch(() => '');
            expect([401, 403], `q="${q}" owner not auth-denied`).not.toContain(status);
            expect(status, `q="${q}" must not 5xx — body=${text}`).toBeLessThan(500);
            if (status === 200) {
                const body = JSON.parse(text) as { status?: string; items?: unknown[] };
                expect(body.status, `q="${q}" success envelope`).toBe('success');
                expect(Array.isArray(body.items), `q="${q}" items is an array`).toBe(true);
                expect(body.items!.length, `q="${q}" empty work → empty page`).toBe(0);
            } else {
                // A strict validator could 400 a malformed page; tolerate but never 5xx.
                expect(status, `q="${q}" is a 4xx, not a 5xx`).toBeGreaterThanOrEqual(400);
            }
        }

        // expect.poll: the count stays a stable numeric 0 across repeated reads —
        // listing has no lazy side-effect that bumps the count.
        await expect
            .poll(
                async () => {
                    const r = await getJson(request, token, `/api/works/${work.id}/count`);
                    if (r.status() !== 200) return -1;
                    return ((await r.json()) as { items?: number }).items ?? -1;
                },
                { timeout: REQ_TIMEOUT, message: 'count is a stable 0 for an empty work' },
            )
            .toBe(0);
    });

    test('cross-tenant isolation + anonymous gate: a stranger gets 403, an anonymous client gets 401, on every item route', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `e2e-items-tenant-${Date.now()}`,
        });

        // A second, unrelated authenticated user → 403 with the exact permission
        // message on both read and write (NOT 200, NOT a silent leak, NOT a 404 —
        // the work exists, the user just lacks access).
        const stranger = await registerUserViaAPI(request);

        const strangerList = await getJson(
            request,
            stranger.access_token,
            `/api/works/${work.id}/items`,
        );
        const strangerListText = await strangerList.text().catch(() => '');
        expect(strangerList.status(), `stranger read → 403; body=${strangerListText}`).toBe(403);
        expect(
            String((JSON.parse(strangerListText) as { message?: string }).message),
            'stranger read surfaces the permission error',
        ).toMatch(/permission/i);

        // The stranger's submit body must be DTO-VALID, otherwise the ValidationPipe
        // (which runs BEFORE the ownership check — PROBED) would 400 it on the
        // missing description/category and we'd never reach the 403 we want to prove.
        const strangerWrite = await postItem(request, stranger.access_token, work.id, {
            name: 'sneaky',
            description: 'sneaky description',
            source_url: 'https://example.com/sneaky',
            category: 'tools',
        });
        expect(
            strangerWrite.status(),
            `stranger (DTO-valid) cannot submit into a foreign work → 403; body=${await strangerWrite.text().catch(() => '')}`,
        ).toBe(403);
        expect(
            String(((await strangerWrite.json()) as { message?: string }).message),
            'stranger write surfaces the permission error (ownership beats the git gate)',
        ).toMatch(/permission/i);

        // And a DTO-INVALID stranger body proves the ordering: validation 400 first.
        const strangerInvalid = await postItem(request, stranger.access_token, work.id, {
            name: 'incomplete',
        });
        expect(
            strangerInvalid.status(),
            'a DTO-invalid stranger submit is rejected by validation (400) before ownership',
        ).toBe(400);
        expect(
            Array.isArray(((await strangerInvalid.json()) as { message?: unknown }).message),
            'validation 400 carries a message array',
        ).toBe(true);

        // A DTO-valid mutator (remove-item) from the stranger is also ownership-
        // gated → 403 permission (NOT the owner's git-gate 400). PROBED.
        const strangerRemove = await postItem(
            request,
            stranger.access_token,
            work.id,
            { item_slug: 'whatever' },
            'remove-item',
        );
        expect(
            strangerRemove.status(),
            `stranger remove-item on a foreign work → 403; body=${await strangerRemove.text().catch(() => '')}`,
        ).toBe(403);
        expect(
            String(((await strangerRemove.json()) as { message?: string }).message),
            'stranger remove-item surfaces the permission error',
        ).toMatch(/permission/i);

        // A TRULY anonymous client (explicit empty storageState — a bare
        // newContext() would inherit the project's auth cookie) → 401 everywhere.
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonReq = anonCtx.request;

            const anonList = await anonReq.get(`${API_BASE}/api/works/${work.id}/items`, {
                timeout: REQ_TIMEOUT,
            });
            expect(anonList.status(), 'anon item list → 401').toBe(401);
            expect(
                ((await anonList.json()) as { statusCode?: number }).statusCode,
                'anon 401 body carries statusCode',
            ).toBe(401);

            const anonWrite = await anonReq.post(`${API_BASE}/api/works/${work.id}/submit-item`, {
                data: { name: 'anon', source_url: 'https://example.com/anon' },
                timeout: REQ_TIMEOUT,
            });
            expect(anonWrite.status(), 'anon submit-item → 401').toBe(401);

            // An absent work id is also auth-gated before any ownership/existence lookup.
            const anonAbsent = await anonReq.get(`${API_BASE}/api/works/${ABSENT_WORK_ID}/count`, {
                timeout: REQ_TIMEOUT,
            });
            expect(anonAbsent.status(), 'anon count on absent work → 401').toBe(401);
        } finally {
            await anonCtx.close();
        }

        // Sanity: the OWNER retains full, consistent read access throughout.
        const ownerItems = await readItemsEnvelope(
            await getJson(request, owner.access_token, `/api/works/${work.id}/items`),
        );
        expect(ownerItems.length, 'owner still sees an empty, accessible work').toBe(0);
    });
});
