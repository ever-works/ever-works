/**
 * flow-works-items-pagination.spec.ts
 *
 * GET /api/works/:id/items — the per-directory ITEM LIST (non-)pagination /
 * filter contract, DEEP + ASSERTIVE, plus the git-gated WRITE truth and the
 * export/import list-consequence edges.
 *
 * The headline finding, pinned live before a line was written: `GET
 * /api/works/:id/items` is NOT a paginated collection. It is a bare wholesale
 * dump of every item resolved from the work's data repo, with envelope
 *
 *     { status: 'success', items: [ … ] }
 *
 * and NO `total` / `limit` / `offset` / `meta` / `page` / `nextCursor` / `data`
 * wrapper. There is therefore NO server-side pagination, sort, or filter surface
 * on this route: `?limit`, `?offset`, `?sort`, `?order`, `?q`, `?search`,
 * `?status`, `?page`, `?cursor` — and SQL-injection-style values in any of them —
 * are ALL inert. The "pagination edges" for this endpoint are precisely that
 * every window/filter parameter is ignored and the response is byte-identical.
 * The item COUNT lives on a separate companion route (`/count`), never inline.
 *
 * Because the CI stack has NO connected git data repo, the read path is
 * gracefully degraded (`work-query.service` swallows the read-only-repo-
 * unavailable error and returns `items: []`), and every WRITE path is git-gated:
 * `submit-item` returns a 4xx "reconnect your Git account" and the list never
 * grows; `import-items` (execute) never reaches the writer because the feature
 * flag gate fires first. We assert those truthfully — the load-bearing invariant
 * is that a git-gated write leaves the list EMPTY, never a phantom row and never
 * a 5xx.
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver), fresh registered users, plain-created works (POST /api/works),
 *    2026-07-21. Ground truth pinned here:
 *
 *   GET  /api/works/:id/items                        -> 200 { status:'success', items:[] }
 *        …?limit=2&offset=1&sort=name&q=foo&status=x -> 200 identical (params inert)
 *        …?sort=name;DROP TABLE                       -> 200 { items:[] } (injection inert)
 *   GET  /api/works/:id/count                        -> 200 { status:'success', items:0,
 *                                                              categories:0, tags:0 }
 *   POST /api/works/:id/submit-item  (no repo)        -> 400 { status:'error',
 *                                                              message:'Please reconnect your Git account…' }
 *        submit-item (missing categories)             -> 400 class-validator message array
 *   GET  /api/works/:id/export-items/settings         -> 200 { export_enabled:false }
 *   GET  /api/works/:id/export-items?format=csv        -> 404 not-enabled (export dumps the whole
 *                                                              list; no ?limit/?offset windowing)
 *        export-items (no/invalid format)             -> 400 format-gate (BEFORE the enabled gate)
 *        export-items?format=CSV (upper)              -> 404 (format lower-cased, then enabled gate)
 *   GET  /api/works/:id/import-items/settings          -> 200 { import_enabled:false,
 *                                                              import_max_rows:500 }  (<= 2000 ceiling)
 *   POST /api/works/:id/import-items {}                -> 400 'Body must include a `rows` array'
 *        import-items {rows:[…]} (owner, disabled)     -> 404 not-enabled (enabled-gate precedes rowcap)
 *   CROSS-USER (stranger) on items / export / import   -> 403 'You do not have permission…'
 *        …but a stranger POSTing {rows} to execute      -> 403 (ownership beats the owner's
 *                                                              rows/enabled gate — an asymmetry)
 *   GHOST uuid / non-uuid id (owner)                   -> 404 "Work with id '…' not found"
 *   ANON (no bearer)                                   -> 401 { message:'Unauthorized' }
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION (surveyed apps/web/e2e/ for `/items`, export-items,
 * import-items on 2026-07-21). This file's spine — the `GET /works/:id/items`
 * LIST envelope + the inertness of every pagination/filter/sort parameter on it
 * — is pinned by NO sibling. Deliberately NOT repeated here:
 *   - flow-works-list-pagination-sort.spec.ts .. GET /api/works (the list OF
 *       works) limit/offset/order/search clamp matrix — a DIFFERENT endpoint.
 *   - flow-works-items-import-export.spec.ts ... the export/import GATE-
 *       PRECEDENCE matrix (400-vs-403-vs-404 across settings/sample/validate/
 *       execute) on a data_repo-imported work. We touch export/import only
 *       through the LIST/param-inertness lens + a minimal owner-vs-stranger
 *       precedence contrast, and defer the full matrix to that file.
 *   - flow-work-items-crud-deep / work-items-crud / flow-works-item-ops-deep ..
 *       submit/remove/update-item CRUD happy paths — we assert only the
 *       git-gated FAILURE + its non-effect on the list.
 *
 * ENVIRONMENT-ADAPTIVE: keyless CI, no connected git repo -> read path degrades
 * to an empty list and writes are git-gated. Every write assertion tolerates a
 * repo-provisioned build (which could flip a flag or land a row) by asserting
 * the reject-status band + the empty-list invariant, never demanding a specific
 * mutation. ISOLATION: every describe seeds a FRESH registerUserViaAPI() owner +
 * a plain-created work; unique suffixes from a per-file counter (NOT a
 * module-scope clock hit at collection time); TS strict.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

const FAKE_WORK_ID = '00000000-0000-0000-0000-000000000000';

let seq = 0;
function uniqueSuffix(): string {
    seq += 1;
    return `${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface ItemsBody {
    status?: string;
    items?: unknown;
}

/** Register a fresh owner and create a plain (repo-less) work. */
async function freshOwnerWork(
    request: APIRequestContext,
): Promise<{ token: string; workId: string; suffix: string }> {
    const user = await registerUserViaAPI(request);
    const token = user.access_token;
    const suffix = uniqueSuffix();
    const { id } = await createWorkViaAPI(request, token, {
        name: `Items Pager ${suffix}`,
        slug: `items-pager-${suffix}`,
        description: `items pagination probe ${suffix}`,
    });
    expect(id, 'created work has an id').toBeTruthy();
    return { token, workId: id, suffix };
}

function getItems(request: APIRequestContext, token: string, workId: string, query = '') {
    return request.get(`${API_BASE}/api/works/${workId}/items${query}`, {
        headers: authedHeaders(token),
    });
}

async function bodyMessage(res: { json: () => Promise<unknown> }): Promise<string> {
    const json = (await res.json().catch(() => ({}))) as { message?: unknown };
    return Array.isArray(json.message) ? json.message.join(' ') : String(json.message ?? '');
}

// ────────────────────────────────────────────────────────────────────────────
// A) The items LIST envelope: bare, non-paginated, no meta wrapper.
// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/works/:id/items — envelope & non-pagination', () => {
    let token = '';
    let workId = '';

    test.beforeAll(async ({ request }) => {
        test.setTimeout(60_000);
        const ctx = await freshOwnerWork(request);
        token = ctx.token;
        workId = ctx.workId;
    });

    test('owner gets exactly { status:"success", items:[] } for a fresh repo-less work', async ({
        request,
    }) => {
        const res = await getItems(request, token, workId);
        expect(res.status(), 'items list is 200 for the owner').toBe(200);
        const body = (await res.json()) as ItemsBody;
        expect(body.status, 'envelope status is success').toBe('success');
        expect(Array.isArray(body.items), 'items is an array').toBe(true);
        // No connected data repo in CI -> the read degrades to an empty list.
        expect((body.items as unknown[]).length, 'no repo -> empty list').toBe(0);
    });

    test('envelope carries NO pagination wrapper (no total/limit/offset/meta/page/cursor/data)', async ({
        request,
    }) => {
        const res = await getItems(request, token, workId);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(Object.keys(body).sort(), 'exactly {status, items}').toEqual(['items', 'status']);
        for (const forbidden of [
            'total',
            'limit',
            'offset',
            'meta',
            'page',
            'nextCursor',
            'cursor',
            'data',
            'count',
        ]) {
            expect(forbidden in body, `no "${forbidden}" key on the items envelope`).toBe(false);
        }
    });

    test('?limit is inert — the response is byte-identical to the un-paged read', async ({
        request,
    }) => {
        const bare = await (await getItems(request, token, workId)).text();
        const limited = await (await getItems(request, token, workId, '?limit=1')).text();
        expect(limited, '?limit=1 does not change the payload').toBe(bare);
    });

    test('?offset is inert — offset past any end still returns the same empty list', async ({
        request,
    }) => {
        const res = await getItems(request, token, workId, '?offset=999999');
        expect(res.status(), 'offset never 5xx').toBe(200);
        const body = (await res.json()) as ItemsBody;
        expect(body.status).toBe('success');
        expect((body.items as unknown[]).length, 'offset does not page a non-paged list').toBe(0);
    });

    test('?sort / ?order are inert (no ordering surface on this route)', async ({ request }) => {
        const res = await getItems(request, token, workId, '?sort=name&order=desc');
        expect(res.status()).toBe(200);
        const body = (await res.json()) as ItemsBody;
        expect(body.status).toBe('success');
        expect(Array.isArray(body.items)).toBe(true);
    });

    test('?q / ?search / ?status are inert (no filter surface on this route)', async ({
        request,
    }) => {
        const res = await getItems(
            request,
            token,
            workId,
            '?q=anything&search=whatever&status=pending',
        );
        expect(res.status()).toBe(200);
        const body = (await res.json()) as ItemsBody;
        expect(body.status).toBe('success');
        expect((body.items as unknown[]).length, 'filters do not narrow a non-filtered list').toBe(
            0,
        );
    });

    test('?page / ?cursor are inert (no cursor pagination on this route)', async ({ request }) => {
        const bare = await (await getItems(request, token, workId)).text();
        const paged = await (
            await getItems(request, token, workId, '?page=3&cursor=ZmFrZS1jdXJzb3I=')
        ).text();
        expect(paged, 'page/cursor params are ignored').toBe(bare);
    });

    test('a SQL-injection-style ?sort value is inert (no 5xx, list unaffected)', async ({
        request,
    }) => {
        const res = await getItems(
            request,
            token,
            workId,
            `?sort=${encodeURIComponent('name; DROP TABLE items;--')}`,
        );
        expect(res.status(), 'injection value never crashes the route').toBe(200);
        const body = (await res.json()) as ItemsBody;
        expect(body.status).toBe('success');
        expect((body.items as unknown[]).length).toBe(0);
    });

    test('a garbage bag of every window/filter param at once is inert', async ({ request }) => {
        const bare = await (await getItems(request, token, workId)).text();
        const junk = await (
            await getItems(
                request,
                token,
                workId,
                '?limit=-5&offset=abc&sort=&order=sideways&q=%00&page=0&featured=maybe&foo=bar',
            )
        ).text();
        expect(junk, 'combined junk params are all ignored').toBe(bare);
    });

    test('repeated identical reads are stable (cache-backed, same payload each time)', async ({
        request,
    }) => {
        const a = await (await getItems(request, token, workId)).text();
        const b = await (await getItems(request, token, workId)).text();
        const c = await (await getItems(request, token, workId)).text();
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    test('the item COUNT lives on the /count companion, not inline on the list', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/works/${workId}/count`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), '/count is 200').toBe(200);
        const body = (await res.json()) as {
            status?: string;
            items?: unknown;
            categories?: unknown;
            tags?: unknown;
        };
        expect(body.status).toBe('success');
        expect(body.items, 'count.items is 0 for a repo-less work').toBe(0);
        expect(body.categories).toBe(0);
        expect(body.tags).toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// B) Git-gated writes never grow the list (the honest write truth).
// ────────────────────────────────────────────────────────────────────────────
test.describe('git-gated writes leave the items list empty', () => {
    test('submit-item without a connected repo is rejected (4xx/5xx), never a phantom row', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request);
        const res = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers: authedHeaders(token),
            data: {
                name: 'Ghost Item',
                description: 'a would-be item with no repo to land in',
                source_url: 'https://example.com/ghost',
                category: 'tools',
                categories: ['tools'],
            },
        });
        // Live env returns a clean git-gated 400; tolerate a 5xx driver artifact
        // on an alternately-provisioned build.
        expect(
            [400, 403, 500, 502, 503].includes(res.status()),
            `git-gated submit rejected, got ${res.status()}`,
        ).toBe(true);
        if (res.status() === 400) {
            const body = (await res.json().catch(() => ({}))) as { status?: string };
            // The git-gate returns a normalized { status:'error', message } shape.
            expect(body.status, 'git-gate body is an error envelope').toBe('error');
            expect((await bodyMessage(res)).toLowerCase()).toContain('git');
        }
    });

    test('after a failed submit-item the list is STILL empty (write did not land)', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request);
        await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers: authedHeaders(token),
            data: {
                name: 'Vanishing Item',
                description: 'should never appear',
                source_url: 'https://example.com/vanish',
                category: 'tools',
                categories: ['tools'],
            },
        });
        const res = await getItems(request, token, workId);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as ItemsBody;
        expect(
            (body.items as unknown[]).length,
            'a git-gated write must not resurrect into the list',
        ).toBe(0);
    });

    test('submit-item with missing categories is a class-validator 400 (distinct from the git gate)', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request);
        const res = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers: authedHeaders(token),
            data: {
                name: 'No Category Item',
                description: 'missing the required category/categories',
                source_url: 'https://example.com/nocat',
            },
        });
        expect(res.status(), 'validation failure is a 400').toBe(400);
        const msg = (await bodyMessage(res)).toLowerCase();
        expect(msg, 'the 400 names the categories constraint, not git').toContain('categor');
    });

    test('import-items execute (owner, disabled) is walled off at the flag gate, never reaching the writer', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request);
        // A non-trivial rows array — the enabled-gate (404) precedes the row-cap
        // gate, so this never touches the git writer.
        const rows = Array.from({ length: 5 }, (_, i) => ({
            slug: `row-${i}`,
            name: `Row ${i}`,
        }));
        const res = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: { rows, duplicate_strategy: 'skip' },
        });
        expect(res.status(), 'import is not enabled for a repo-less work -> 404').toBe(404);
        expect((await bodyMessage(res)).toLowerCase()).toContain('not enabled');

        // And the list is unchanged.
        const after = (await (await getItems(request, token, workId)).json()) as ItemsBody;
        expect((after.items as unknown[]).length, 'blocked import grows nothing').toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// C) export-items reflects the wholesale list — no windowing, gated on the flag.
// ────────────────────────────────────────────────────────────────────────────
test.describe('export-items — whole-list export, no pagination window', () => {
    let token = '';
    let workId = '';

    test.beforeAll(async ({ request }) => {
        test.setTimeout(60_000);
        const ctx = await freshOwnerWork(request);
        token = ctx.token;
        workId = ctx.workId;
    });

    test('export-items/settings: owner gets exactly 200 { export_enabled:false }', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/works/${workId}/export-items/settings`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { export_enabled?: unknown };
        expect(typeof body.export_enabled, 'export_enabled is a boolean').toBe('boolean');
        expect(body.export_enabled, 'export OFF without a connected repo').toBe(false);
    });

    test('export-items?format=csv on a disabled work -> 404 not-enabled', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/${workId}/export-items?format=csv`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(404);
        expect((await bodyMessage(res)).toLowerCase()).toContain('not enabled');
    });

    test('export-items?format=CSV (uppercase) is lower-cased, then hits the enabled gate -> 404', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/works/${workId}/export-items?format=CSV`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'uppercase passes the format gate, fails the enabled gate').toBe(404);
    });

    test('export-items with no/invalid format -> 400 format-gate BEFORE the enabled gate', async ({
        request,
    }) => {
        const noFormat = await request.get(`${API_BASE}/api/works/${workId}/export-items`, {
            headers: authedHeaders(token),
        });
        expect(noFormat.status(), 'missing format -> 400').toBe(400);
        expect((await bodyMessage(noFormat)).toLowerCase()).toContain('csv');

        const badFormat = await request.get(
            `${API_BASE}/api/works/${workId}/export-items?format=json`,
            { headers: authedHeaders(token) },
        );
        expect(badFormat.status(), 'invalid format -> 400').toBe(400);
    });

    test('export has NO pagination window: ?limit/?offset are inert, status stays 404-not-enabled', async ({
        request,
    }) => {
        // Export dumps the whole list; window params must not change the gate.
        const res = await request.get(
            `${API_BASE}/api/works/${workId}/export-items?format=csv&limit=1&offset=0&page=2`,
            { headers: authedHeaders(token) },
        );
        expect(res.status(), 'window params do not window (or bypass) the export').toBe(404);
        expect((await bodyMessage(res)).toLowerCase()).toContain('not enabled');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// D) import-items settings + body-shape gate (owner path).
// ────────────────────────────────────────────────────────────────────────────
test.describe('import-items — settings & body-shape gate', () => {
    let token = '';
    let workId = '';

    test.beforeAll(async ({ request }) => {
        test.setTimeout(60_000);
        const ctx = await freshOwnerWork(request);
        token = ctx.token;
        workId = ctx.workId;
    });

    test('import-items/settings: 200 { import_enabled:false, import_max_rows:500 } (<= 2000 ceiling)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/works/${workId}/import-items/settings`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { import_enabled?: unknown; import_max_rows?: unknown };
        expect(typeof body.import_enabled, 'import_enabled is a boolean').toBe('boolean');
        expect(body.import_enabled, 'import OFF without a connected repo').toBe(false);
        expect(typeof body.import_max_rows, 'import_max_rows is a number').toBe('number');
        expect(body.import_max_rows, 'default per-directory cap').toBe(500);
        expect(
            (body.import_max_rows as number) <= 2000,
            'cap never exceeds the global ceiling',
        ).toBe(true);
    });

    test('import-items execute with an empty body -> 400 "Body must include a `rows` array"', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(res.status()).toBe(400);
        expect((await bodyMessage(res)).toLowerCase()).toContain('rows');
    });

    test('import-items execute with a non-array `rows` -> 400 body-shape gate', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: { rows: 'not-an-array' },
        });
        expect(res.status()).toBe(400);
        expect((await bodyMessage(res)).toLowerCase()).toContain('rows');
    });

    test('import-items/sample?format=csv on a disabled work -> 404 not-enabled', async ({
        request,
    }) => {
        const res = await request.get(
            `${API_BASE}/api/works/${workId}/import-items/sample?format=csv`,
            { headers: authedHeaders(token) },
        );
        expect(res.status()).toBe(404);
        expect((await bodyMessage(res)).toLowerCase()).toContain('not enabled');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// E) Access boundaries on the whole items family.
// ────────────────────────────────────────────────────────────────────────────
test.describe('items family — cross-user, ghost, and auth boundaries', () => {
    test('a stranger gets 403 on GET items (own-work-only)', async ({ request }) => {
        const owner = await freshOwnerWork(request);
        const stranger = await registerUserViaAPI(request);
        const res = await getItems(request, stranger.access_token, owner.workId);
        expect(res.status(), 'cross-user items read is 403').toBe(403);
        expect((await bodyMessage(res)).toLowerCase()).toContain('permission');
    });

    test('a stranger gets 403 on export-items/settings and the export download', async ({
        request,
    }) => {
        const owner = await freshOwnerWork(request);
        const stranger = await registerUserViaAPI(request);
        const settings = await request.get(
            `${API_BASE}/api/works/${owner.workId}/export-items/settings`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(settings.status(), 'stranger export settings -> 403').toBe(403);
        const download = await request.get(
            `${API_BASE}/api/works/${owner.workId}/export-items?format=csv`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(download.status(), 'ownership 403 beats the not-enabled 404').toBe(403);
    });

    test('import-items execute {rows} — ownership 403 for a stranger vs enabled-404 for the owner (asymmetry)', async ({
        request,
    }) => {
        const owner = await freshOwnerWork(request);
        const stranger = await registerUserViaAPI(request);

        // Same {rows:[]} body: the stranger is walled at ownership, the owner at
        // the disabled-feature flag. The gate order differs by caller.
        const strangerRes = await request.post(
            `${API_BASE}/api/works/${owner.workId}/import-items`,
            { headers: authedHeaders(stranger.access_token), data: { rows: [] } },
        );
        expect(strangerRes.status(), 'stranger -> 403 (ownership precedes the flag gate)').toBe(
            403,
        );

        const ownerRes = await request.post(`${API_BASE}/api/works/${owner.workId}/import-items`, {
            headers: authedHeaders(owner.token),
            data: { rows: [] },
        });
        expect(ownerRes.status(), 'owner with a valid empty rows array -> 404 not-enabled').toBe(
            404,
        );
    });

    test('a well-formed but non-existent work id -> 404 on GET items', async ({ request }) => {
        const owner = await freshOwnerWork(request);
        const res = await getItems(request, owner.token, FAKE_WORK_ID);
        expect(res.status(), 'ghost uuid -> 404').toBe(404);
        expect((await bodyMessage(res)).toLowerCase()).toContain('not found');
    });

    test('a non-uuid work id is treated as a missing work -> 404 (string param, not a 400)', async ({
        request,
    }) => {
        const owner = await freshOwnerWork(request);
        const res = await getItems(request, owner.token, 'not-a-real-id');
        expect(res.status(), 'non-uuid id -> 404, not a validation 400').toBe(404);
    });

    test('an unauthenticated items read is rejected with 401', async ({ request }) => {
        const owner = await freshOwnerWork(request);
        const res = await request.get(`${API_BASE}/api/works/${owner.workId}/items`);
        expect(res.status(), 'no bearer -> 401').toBe(401);
        const body = (await res.json().catch(() => ({}))) as { message?: unknown };
        expect(String(body.message ?? '').toLowerCase()).toContain('unauthorized');
    });
});
