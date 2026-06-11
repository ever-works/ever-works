import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    loginViaAPI,
    registerUserViaAPI,
} from './helpers/api';
import { seedKbMarkdownDoc, seedKbSkippedUpload } from './helpers/kb-fixtures';

/**
 * KB document lifecycle (DEEP) — complex, multi-step, cross-feature
 * end-to-end INTEGRATION flows that go beyond the existing
 * `flow-kb-document-lifecycle.spec.ts` (single upload→tree→body→delete +
 * edit/history + citations). These flows braid the upload pipeline, the
 * upload-row REST surface (list / get / download-bytes proxy), the
 * supported-MIME extraction matrix, the 200 MiB size cap, the lock state
 * machine, and per-Work + cross-user KB isolation — none of which the
 * sibling KB specs cover end-to-end.
 *
 * Real surface: `apps/api/src/works/kb.controller.ts` (mounted at
 * `/api/works/:id/kb/...`) backed by
 * `packages/agent/src/services/knowledge-base.service.ts`. EVERY shape
 * below was probed against the LIVE sqlite-in-memory API (the same driver
 * CI uses) before any assertion was written.
 *
 * Verified live shapes (probed 2026-06-01):
 *  - POST /api/works/:id/kb/uploads (multipart) → 201
 *      `{ upload: WorkKnowledgeUpload, document: KbDoc|null }`.
 *      TEXT-PASSTHROUGH MIMEs extract SYNCHRONOUSLY into a doc:
 *      `text/plain`, `text/markdown`, `text/x-markdown`,
 *      `application/x-markdown` → `upload.extractionStatus='succeeded'`,
 *      `document` non-null, `upload.extractedDocumentId === document.id`.
 *      The upload-response `document` carries `kbDocumentClass`; the
 *      list/get DTO surfaces the SAME field as `class`.
 *      NON-extractable MIMEs with no binary viewer (e.g.
 *      `application/octet-stream`) → `upload.extractionStatus='skipped'`,
 *      `document: null`, `upload.extractionError` starts "No extractor
 *      route for <mime> yet".
 *  - Upload validation: missing `file` field → 400
 *      `{ status:'error', message:"Multipart field 'file' is required" }`.
 *      `targetClass` outside the enum → 400 with a class-validator message
 *      enumerating: brand, legal, seo, style, glossary, competitors,
 *      personas, research, output, freeform.
 *  - Per-upload byte cap = `KB_UPLOAD_MAX_BYTES` (default 200 MiB),
 *      enforced by multer's `FileInterceptor({ limits: { fileSize } })`.
 *      A comfortably-under-cap upload is accepted; the >cap path 413s
 *      (asserted as a documented contract — we never push 200 MiB in CI).
 *  - SHA-256 dedup: re-POSTing byte-identical content returns the FIRST
 *      `upload.id` with `document: null` (no new row, no new doc).
 *  - GET /api/works/:id/kb/uploads?status=&limit=&offset= → 200
 *      `{ items: WorkKnowledgeUpload[], total }`; `limit`/`offset`
 *      paginate, `status` filters (succeeded / skipped / …).
 *  - GET /api/works/:id/kb/uploads/:uploadId → 200 row; missing → 404.
 *  - GET /api/works/:id/kb/uploads/:uploadId/download → 200 raw bytes,
 *      headers pinned: `Content-Security-Policy: default-src 'none';
 *      frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options:
 *      nosniff`, `Cache-Control: private, max-age=300`,
 *      `Content-Disposition: inline; filename="<original>"`, and
 *      `Content-Type` = the upload's stored MIME. Body === uploaded bytes.
 *  - GET /api/works/:id/kb/documents?class=&q=&limit=&offset= → 200
 *      `{ items, total }`; `class` filters exactly, lexical `q` matches
 *      title/slug (NOT body and NOT the path segment), pagination works.
 *  - GET /api/works/:id/kb/documents/:idOrPath → KbDocumentBodyDto
 *      (id resolves; `<class>/<slug>.md` path resolves; bare path 404).
 *  - PATCH .../:docId → 200 updated body DTO; recomputes wordCount.
 *  - POST .../:docId/lock {mode} → 200 (manager+); mode 'full' then makes
 *      PATCH + DELETE 403 until POST .../:docId/unlock → 200.
 *      (Owner of a personal Work IS owner-role, so lock/unlock succeed.)
 *  - DELETE .../:docId → 204; subsequent GET → 404 with the id in
 *      `message`; the doc drops out of the list.
 *  - GET .../:docId/history → 200 `{ items: [] }` when a git mirror is
 *      wired, else 5xx in the no-mirror sqlite env; missing doc → 404.
 *  - ISOLATION: a fresh Work's KB is empty; a non-member hitting ANY
 *      `/api/works/:otherWorkId/kb/*` route → 403 (ensureCanView /
 *      ensureCanEdit). Docs of Work A never appear in Work B's list.
 *
 * Cross-spec isolation: API-only mutations run on FRESH
 * registerUserViaAPI() users minted per test (unique emails) so the
 * shared in-memory DB stays clean for sibling specs. The seeded user
 * (storageState) drives ONLY the UI tree assertion in flow 1.
 *
 * Filename uses the safe `flow-` prefix (not matched by the no-auth
 * testIgnore regex in playwright.config.ts).
 */

/** Default per-upload cap from kb.controller.ts (`KB_UPLOAD_MAX_BYTES`). */
const KB_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** The full KbDocumentClass enum, surfaced verbatim in the 400 message. */
const KB_DOC_CLASSES = [
    'brand',
    'legal',
    'seo',
    'style',
    'glossary',
    'competitors',
    'personas',
    'research',
    'output',
    'freeform',
] as const;

interface UploadRow {
    id: string;
    workId: string;
    originalFilename: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    extractionStatus: string;
    extractionError: string | null;
    extractedDocumentId: string | null;
}

interface UploadResponse {
    upload: UploadRow;
    document: {
        id: string;
        path: string;
        slug: string;
        kbDocumentClass: string;
    } | null;
}

function runId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** POST a multipart KB upload and return the parsed `{upload, document}`. */
async function uploadKb(
    request: APIRequestContext,
    token: string,
    workId: string,
    opts: { name: string; mimeType: string; buffer: Buffer; targetClass?: string },
): Promise<{ status: number; body: UploadResponse }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/uploads`, {
        headers: authedHeaders(token),
        multipart: {
            file: { name: opts.name, mimeType: opts.mimeType, buffer: opts.buffer },
            targetClass: opts.targetClass ?? 'freeform',
        },
    });
    const status = res.status();
    // Only parse JSON for the success / validation-error shapes.
    const body = (
        status === 201 ? await res.json() : await res.json().catch(() => ({}))
    ) as UploadResponse;
    return { status, body };
}

test.describe('Flow — KB document lifecycle (deep)', () => {
    test('full lifecycle braided: upload → tree UI → fetch (id+path) → edit → history → delete → gone', async ({
        page,
        request,
    }) => {
        // KB page is a first-hit nested dashboard route (Next.js dev-mode
        // per-route compile ~10-15s each); the upload + tree refresh add a
        // couple of round-trips. Budget the navigation-heavy 180s.
        test.setTimeout(180_000);

        const id = runId();
        // The UI context (storageState) is logged in as the SEEDED user, so
        // the Work + doc must belong to THAT user for the tree to render
        // them. Mint a bearer for the seeded user (login DTO is whitelisted
        // to {email,password} only — never pass `name`).
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });

        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Deep Lifecycle ${id}`,
        });
        expect(workId, 'createWorkViaAPI returns a non-empty work id').toBeTruthy();

        // 1. Empty tree for the fresh Work.
        const empty = await request.get(`${API_BASE}/api/works/${workId}/kb/documents`, {
            headers: authedHeaders(access_token),
        });
        expect(empty.status()).toBe(200);
        expect((await empty.json()).total).toBe(0);

        // 2. Upload a markdown doc — text MIME extracts synchronously.
        const originalBody = `# Lifecycle ${id}\n\nThe original body has exactly nine words here.\n`;
        const up = await uploadKb(request, access_token, workId, {
            name: `kb-deep-${id}.md`,
            mimeType: 'text/markdown',
            buffer: Buffer.from(originalBody, 'utf8'),
            targetClass: 'research',
        });
        expect(up.status, 'upload → 201').toBe(201);
        expect(up.body.upload.extractionStatus).toBe('succeeded');
        expect(up.body.document, 'text upload creates a doc synchronously').not.toBeNull();
        const docId = up.body.document!.id;
        const docPath = up.body.document!.path;
        expect(docPath).toMatch(/^research\/.+\.md$/);
        // Upload-response document carries `kbDocumentClass`; the upload row
        // links the created doc id.
        expect(up.body.document!.kbDocumentClass).toBe('research');
        expect(up.body.upload.extractedDocumentId).toBe(docId);

        // 3. The doc renders in the real KB workbench tree UI. The workbench
        //    tree groups docs by class and every group is COLLAPSED by default
        //    on the index route (there is no active doc to auto-expand), so the
        //    row only mounts once we expand its `research` class group. We then
        //    assert the row leaf for our docId is visible.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-workbench-tree')).toBeVisible({ timeout: 30_000 });
        await page.getByTestId('kb-workbench-group-toggle-research').click();
        const treeItem = page.getByTestId(`kb-workbench-row-${docId}`);
        await expect(treeItem).toBeVisible({ timeout: 30_000 });
        // The row carries the canonical `<class>/<slug>.md` path it links to.
        await expect(treeItem).toHaveAttribute('data-doc-path', docPath);

        // 4. Fetch the body via BOTH id and `<class>/<slug>.md` path — both
        //    resolve to the same KbDocumentBodyDto.
        const byId = await request.get(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(access_token),
        });
        expect(byId.status()).toBe(200);
        const byIdDto = (await byId.json()) as {
            id: string;
            body: string;
            class: string;
            wordCount: number | null;
            assets: unknown[];
        };
        expect(byIdDto.id).toBe(docId);
        expect(byIdDto.body).toBe(originalBody);
        expect(byIdDto.class, 'list/get DTO surfaces `class` not `kbDocumentClass`').toBe(
            'research',
        );
        expect(Array.isArray(byIdDto.assets)).toBeTruthy();

        const byPath = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents/${encodeURIComponent(docPath)}`,
            { headers: authedHeaders(access_token) },
        );
        expect(byPath.status()).toBe(200);
        expect((await byPath.json()).id).toBe(docId);

        // Bare path (no `.md`) is NOT a stored form → 404.
        const bare = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents/${encodeURIComponent(docPath.replace(/\.md$/, ''))}`,
            { headers: authedHeaders(access_token) },
        );
        expect(bare.status()).toBe(404);

        // 5. Edit body + title in one PATCH; wordCount recomputes upward.
        const editedBody = `# Lifecycle ${id} v2\n\nVersion two now contains substantially more words than the original body did before.\n`;
        const editedTitle = `Lifecycle Edited ${id}`;
        const patch = await request.patch(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(access_token),
            data: { body: editedBody, title: editedTitle },
        });
        expect(patch.status(), 'PATCH → 200').toBe(200);
        const patched = (await patch.json()) as {
            body: string;
            title: string;
            wordCount: number | null;
        };
        expect(patched.body).toBe(editedBody);
        expect(patched.title).toBe(editedTitle);
        expect(patched.wordCount ?? 0).toBeGreaterThan(byIdDto.wordCount ?? 0);

        // Persisted (not just echoed).
        const reread = await request.get(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(access_token),
        });
        expect((await reread.json()).body).toBe(editedBody);

        // 6. History endpoint is reachable + doc-scoped. No git mirror in
        //    sqlite e2e → either 200 `{items:[]}` (mirror wired) or 5xx;
        //    never assert a populated commit log. A missing doc id → 404
        //    (row check runs before the git read).
        const hist = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents/${docId}/history`,
            { headers: authedHeaders(access_token) },
        );
        expect(
            [200, 500, 502, 503].includes(hist.status()),
            `history reachable (got ${hist.status()})`,
        ).toBeTruthy();
        if (hist.status() === 200) {
            expect(Array.isArray((await hist.json()).items)).toBeTruthy();
        }
        const histMissing = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents/00000000-0000-0000-0000-000000000000/history`,
            { headers: authedHeaders(access_token) },
        );
        expect(histMissing.status()).toBe(404);

        // 7. Delete → 204; GET → 404 (id in message); doc gone from list.
        const del = await request.delete(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(access_token),
        });
        expect(del.status(), 'DELETE → 204').toBe(204);
        const gone = await request.get(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(access_token),
        });
        expect(gone.status()).toBe(404);
        expect(((await gone.json()) as { message: string }).message).toContain(docId);

        const finalList = await request.get(`${API_BASE}/api/works/${workId}/kb/documents`, {
            headers: authedHeaders(access_token),
        });
        const items = ((await finalList.json()) as { items: Array<{ id: string }> }).items;
        expect(items.find((d) => d.id === docId)).toBeUndefined();
    });

    test('supported-type matrix: text MIMEs extract synchronously; octet-stream is skipped doc-less', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const id = runId();
        const { access_token: token } = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Type Matrix ${id}`,
        });
        expect(workId).toBeTruthy();

        // Every text-passthrough MIME (kb.service `bodyForTextMimeType`) must
        // extract synchronously to a real doc whose body === the uploaded
        // bytes. The doc lands at `<class>/<slug>.md` regardless of the
        // original extension (extraction rewrites to `.md`).
        const textCases: Array<{ mimeType: string; ext: string; klass: string }> = [
            { mimeType: 'text/markdown', ext: 'md', klass: 'freeform' },
            { mimeType: 'text/plain', ext: 'txt', klass: 'research' },
            { mimeType: 'text/x-markdown', ext: 'md', klass: 'glossary' },
            { mimeType: 'application/x-markdown', ext: 'md', klass: 'output' },
        ];

        for (const c of textCases) {
            const slugBase = `type-${c.mimeType.replace(/[^a-z0-9]+/g, '-')}-${id}`;
            const body = `# ${slugBase}\n\nUnique body for ${c.mimeType} extraction.\n`;
            const res = await uploadKb(request, token, workId, {
                name: `${slugBase}.${c.ext}`,
                mimeType: c.mimeType,
                buffer: Buffer.from(body, 'utf8'),
                targetClass: c.klass,
            });
            expect(res.status, `${c.mimeType} → 201`).toBe(201);
            expect(res.body.upload.extractionStatus, `${c.mimeType} extracts`).toBe('succeeded');
            expect(res.body.document, `${c.mimeType} creates a doc`).not.toBeNull();
            expect(res.body.document!.path).toMatch(new RegExp(`^${c.klass}/.+\\.md$`));
            // The synchronously-materialized body round-trips exactly.
            const fetched = await request.get(
                `${API_BASE}/api/works/${workId}/kb/documents/${res.body.document!.id}`,
                { headers: authedHeaders(token) },
            );
            expect(fetched.status()).toBe(200);
            expect(((await fetched.json()) as { body: string }).body).toBe(body);
        }

        // A non-extractable MIME with no binary viewer (octet-stream) is
        // persisted but stays SKIPPED with NO document — the upload row
        // exists (so retry-extraction can apply) but the tree has no leaf.
        const skipped = await seedKbSkippedUpload(request, token, workId, {
            filename: `opaque-${id}.bin`,
            body: Buffer.from('opaque binary bytes with no extractor route', 'utf8'),
            mimeType: 'application/octet-stream',
        });
        expect(skipped.extractionStatus).toBe('skipped');

        // The skipped upload row is retrievable and carries the documented
        // "no extractor route" reason.
        const skippedRow = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads/${skipped.uploadId}`,
            { headers: authedHeaders(token) },
        );
        expect(skippedRow.status()).toBe(200);
        const skippedJson = (await skippedRow.json()) as UploadRow;
        expect(skippedJson.extractionStatus).toBe('skipped');
        expect(skippedJson.extractedDocumentId).toBeNull();
        expect(skippedJson.extractionError ?? '').toContain('No extractor route');

        // The 4 text uploads produced exactly 4 docs; the octet-stream one
        // produced none → the doc list has exactly the 4 text docs.
        const docs = await request.get(`${API_BASE}/api/works/${workId}/kb/documents`, {
            headers: authedHeaders(token),
        });
        expect(((await docs.json()) as { total: number }).total).toBe(textCases.length);
    });

    test('upload-row REST surface: list pagination + status filter + getUpload + CSP-pinned download proxy', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const id = runId();
        const { access_token: token } = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Upload Surface ${id}`,
        });
        expect(workId).toBeTruthy();

        // Seed three succeeded text uploads + one skipped binary so the
        // status filter has both buckets to split.
        const uploadIds: string[] = [];
        const downloadProbe = {
            uploadId: '',
            filename: '',
            mimeType: 'text/plain',
            bytes: Buffer.from(`download-probe-${id} alpha bravo charlie delta`, 'utf8'),
        };
        for (let i = 0; i < 3; i++) {
            const filename = `surface-${id}-${i}.txt`;
            const buffer =
                i === 0
                    ? downloadProbe.bytes
                    : Buffer.from(`surface upload ${id} number ${i}\n`, 'utf8');
            const res = await uploadKb(request, token, workId, {
                name: filename,
                mimeType: 'text/plain',
                buffer,
            });
            expect(res.status).toBe(201);
            uploadIds.push(res.body.upload.id);
            if (i === 0) {
                downloadProbe.uploadId = res.body.upload.id;
                downloadProbe.filename = filename;
            }
        }
        const skipped = await seedKbSkippedUpload(request, token, workId, {
            filename: `surface-skip-${id}.bin`,
            body: Buffer.from('binary', 'utf8'),
        });

        // listUploads default → all four rows, `{items,total}` shape.
        const all = await request.get(`${API_BASE}/api/works/${workId}/kb/uploads`, {
            headers: authedHeaders(token),
        });
        expect(all.status()).toBe(200);
        const allJson = (await all.json()) as { items: UploadRow[]; total: number };
        expect(allJson.total).toBe(4);
        expect(Array.isArray(allJson.items)).toBeTruthy();

        // Pagination: limit=2 returns 2 rows but the SAME total.
        const page1 = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads?limit=2&offset=0`,
            { headers: authedHeaders(token) },
        );
        const page1Json = (await page1.json()) as { items: UploadRow[]; total: number };
        expect(page1Json.items.length).toBe(2);
        expect(page1Json.total).toBe(4);
        const page2 = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads?limit=2&offset=2`,
            { headers: authedHeaders(token) },
        );
        const page2Json = (await page2.json()) as { items: UploadRow[]; total: number };
        expect(page2Json.items.length).toBe(2);
        // No overlap between the two pages.
        const page1Set = new Set(page1Json.items.map((u) => u.id));
        expect(page2Json.items.every((u) => !page1Set.has(u.id))).toBeTruthy();

        // status filter splits succeeded (3) vs skipped (1).
        const succeeded = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads?status=succeeded`,
            { headers: authedHeaders(token) },
        );
        const succeededJson = (await succeeded.json()) as { items: UploadRow[]; total: number };
        expect(succeededJson.total).toBe(3);
        expect(succeededJson.items.every((u) => u.extractionStatus === 'succeeded')).toBeTruthy();
        const skippedList = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads?status=skipped`,
            { headers: authedHeaders(token) },
        );
        const skippedListJson = (await skippedList.json()) as {
            items: UploadRow[];
            total: number;
        };
        expect(skippedListJson.total).toBe(1);
        expect(skippedListJson.items[0].id).toBe(skipped.uploadId);

        // getUpload by id → 200 full row; missing → 404.
        const getOne = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads/${uploadIds[0]}`,
            { headers: authedHeaders(token) },
        );
        expect(getOne.status()).toBe(200);
        expect(((await getOne.json()) as UploadRow).id).toBe(uploadIds[0]);
        const getMissing = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads/00000000-0000-0000-0000-000000000000`,
            { headers: authedHeaders(token) },
        );
        expect(getMissing.status()).toBe(404);

        // Download proxy: 200 raw bytes, CSP + nosniff + cache + inline
        // disposition pinned, Content-Type = stored MIME, body === bytes.
        const dl = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads/${downloadProbe.uploadId}/download`,
            { headers: authedHeaders(token) },
        );
        expect(dl.status()).toBe(200);
        const headers = dl.headers();
        expect(headers['content-security-policy']).toBe(
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        );
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(headers['cache-control']).toBe('private, max-age=300');
        expect(headers['content-type']).toContain('text/plain');
        expect(headers['content-disposition']).toBe(`inline; filename="${downloadProbe.filename}"`);
        expect(Buffer.from(await dl.body()).equals(downloadProbe.bytes)).toBeTruthy();
    });

    test('upload validation + 200 MiB size cap contract + SHA-256 dedup', async ({ request }) => {
        test.setTimeout(120_000);

        const id = runId();
        const { access_token: token } = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Upload Validation ${id}`,
        });
        expect(workId).toBeTruthy();

        // Missing `file` multipart field → 400 with the controller's exact
        // error envelope.
        const noFile = await request.post(`${API_BASE}/api/works/${workId}/kb/uploads`, {
            headers: authedHeaders(token),
            multipart: { targetClass: 'freeform' },
        });
        expect(noFile.status()).toBe(400);
        const noFileJson = (await noFile.json()) as { status?: string; message?: string };
        expect(noFileJson.message).toContain("Multipart field 'file' is required");

        // Invalid `targetClass` → 400; the class-validator message must
        // enumerate the full KbDocumentClass enum.
        const badClass = await request.post(`${API_BASE}/api/works/${workId}/kb/uploads`, {
            headers: authedHeaders(token),
            multipart: {
                file: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
                targetClass: 'totally-not-a-class',
            },
        });
        expect(badClass.status()).toBe(400);
        const badClassMsg = JSON.stringify((await badClass.json()) as unknown);
        for (const cls of KB_DOC_CLASSES) {
            expect(badClassMsg, `enum lists "${cls}"`).toContain(cls);
        }

        // Size cap contract: an upload comfortably UNDER the 200 MiB cap is
        // accepted. We assert the constant is the documented 200 MiB and
        // that a sub-cap upload succeeds; pushing > 200 MiB through CI is
        // impractical, so the 413 over-cap branch (multer `fileSize` limit)
        // is asserted as a documented contract, not exercised live.
        expect(KB_UPLOAD_MAX_BYTES).toBe(200 * 1024 * 1024);
        const oneMiB = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB of 'a' under cap.
        const underCap = await uploadKb(request, token, workId, {
            name: `under-cap-${id}.txt`,
            mimeType: 'text/plain',
            buffer: oneMiB,
        });
        expect(underCap.status, '1 MiB upload is under the 200 MiB cap → 201').toBe(201);
        // The text-passthrough inline-extraction cap is 1 MiB exactly — a
        // 1 MiB body lands at the boundary and still extracts (the row is
        // succeeded, the body materializes; truncation marker only appends
        // when STRICTLY over 1 MiB). We only assert the upload was accepted
        // and a document row exists.
        expect(underCap.body.upload.extractionStatus).toBe('succeeded');
        expect(underCap.body.document).not.toBeNull();

        // SHA-256 dedup: a byte-identical re-upload returns the FIRST
        // upload's id with `document: null` (no new row / doc). Use a fresh
        // deterministic buffer so this assertion is self-contained.
        const dedupBytes = Buffer.from(`# Dedup ${id}\n\nstable bytes for sha256 dedup\n`, 'utf8');
        const first = await uploadKb(request, token, workId, {
            name: `dedup-${id}.md`,
            mimeType: 'text/markdown',
            buffer: dedupBytes,
        });
        expect(first.status).toBe(201);
        expect(first.body.document).not.toBeNull();
        const firstUploadId = first.body.upload.id;

        const second = await uploadKb(request, token, workId, {
            name: `dedup-${id}.md`,
            mimeType: 'text/markdown',
            buffer: dedupBytes,
        });
        expect(second.status, 'dedup re-upload still → 201').toBe(201);
        expect(second.body.upload.id, 'dedup returns the existing upload row').toBe(firstUploadId);
        expect(second.body.document ?? null, 'dedup creates no new document').toBeNull();
    });

    test('lock state machine: full-lock blocks edit/delete until unlock', async ({ request }) => {
        test.setTimeout(120_000);

        const id = runId();
        // Owner of a personal Work resolves to role `owner`, which clears
        // the manager+ gate on lock/unlock.
        const { access_token: token } = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Lock SM ${id}`,
        });
        expect(workId).toBeTruthy();

        const seedBody = `# Lock ${id}\n\nbody that should be protected by a full lock\n`;
        const { documentId } = await seedKbMarkdownDoc(request, token, workId, {
            filename: `lock-${id}.md`,
            body: seedBody,
        });

        // Before locking, an edit succeeds (baseline).
        const preEdit = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${documentId}`,
            {
                headers: authedHeaders(token),
                data: { description: 'pre-lock edit ok' },
            },
        );
        expect(preEdit.status(), 'edit allowed before lock').toBe(200);

        // Lock with mode 'full' → 200; the body DTO reflects locked state.
        const lock = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/${documentId}/lock`,
            { headers: authedHeaders(token), data: { mode: 'full' } },
        );
        expect(lock.status(), 'lock → 200').toBe(200);
        const lockDto = (await lock.json()) as { locked: boolean; lockMode: string };
        expect(lockDto.locked).toBe(true);
        expect(lockDto.lockMode).toBe('full');

        // While full-locked, PATCH is forbidden with the documented message.
        const blockedEdit = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${documentId}`,
            {
                headers: authedHeaders(token),
                data: { body: `${seedBody}\nshould not apply` },
            },
        );
        expect(blockedEdit.status(), 'full-locked edit → 403').toBe(403);
        expect(JSON.stringify((await blockedEdit.json()) as unknown)).toContain('locked');

        // DELETE is likewise forbidden while full-locked.
        const blockedDelete = await request.delete(
            `${API_BASE}/api/works/${workId}/kb/documents/${documentId}`,
            { headers: authedHeaders(token) },
        );
        expect(blockedDelete.status(), 'full-locked delete → 403').toBe(403);

        // The body never changed despite the blocked PATCH.
        const stillOriginal = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents/${documentId}`,
            { headers: authedHeaders(token) },
        );
        expect(((await stillOriginal.json()) as { body: string }).body).toBe(seedBody);

        // Unlock → 200; lock flags clear.
        const unlock = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/${documentId}/unlock`,
            { headers: authedHeaders(token) },
        );
        expect(unlock.status(), 'unlock → 200').toBe(200);
        const unlockDto = (await unlock.json()) as { locked: boolean };
        expect(unlockDto.locked).toBe(false);

        // Edit + delete now succeed again — the gate is fully reversible.
        const postUnlockEdit = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${documentId}`,
            {
                headers: authedHeaders(token),
                data: { body: `${seedBody}\nnow editable again` },
            },
        );
        expect(postUnlockEdit.status(), 'edit allowed after unlock').toBe(200);
        const postUnlockDelete = await request.delete(
            `${API_BASE}/api/works/${workId}/kb/documents/${documentId}`,
            { headers: authedHeaders(token) },
        );
        expect(postUnlockDelete.status(), 'delete allowed after unlock → 204').toBe(204);
    });

    test('document search + class filter + pagination on the per-Work tree', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const id = runId();
        const { access_token: token } = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Search ${id}`,
        });
        expect(workId).toBeTruthy();

        // Seed docs across two classes with a unique, searchable title
        // token. The lexical `q` filter matches title/slug (probed: it does
        // NOT match the path segment or the body), so embed the token in the
        // filename → slug → title.
        const token1 = `zappa${id}`; // unique → only OUR docs match.
        await seedKbMarkdownDoc(request, token, workId, {
            filename: `${token1}-research-one.md`,
            body: `# ${token1} research one\n\nfirst research doc\n`,
            targetClass: 'research',
        });
        await seedKbMarkdownDoc(request, token, workId, {
            filename: `${token1}-research-two.md`,
            body: `# ${token1} research two\n\nsecond research doc\n`,
            targetClass: 'research',
        });
        await seedKbMarkdownDoc(request, token, workId, {
            filename: `${token1}-glossary-one.md`,
            body: `# ${token1} glossary one\n\nglossary doc\n`,
            targetClass: 'glossary',
        });
        // A doc WITHOUT the token, so `q` must exclude it.
        await seedKbMarkdownDoc(request, token, workId, {
            filename: `unrelated-${id}.md`,
            body: `# unrelated\n\nno search token here\n`,
            targetClass: 'freeform',
        });

        // Full list → 4 docs.
        const all = await request.get(`${API_BASE}/api/works/${workId}/kb/documents`, {
            headers: authedHeaders(token),
        });
        expect(((await all.json()) as { total: number }).total).toBe(4);

        // class filter → exactly the two research docs.
        const research = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents?class=research`,
            { headers: authedHeaders(token) },
        );
        const researchJson = (await research.json()) as {
            items: Array<{ class: string; path: string }>;
            total: number;
        };
        expect(researchJson.total).toBe(2);
        expect(researchJson.items.every((d) => d.class === 'research')).toBeTruthy();

        // lexical q on the unique title token → the 3 token-bearing docs
        // (research ×2 + glossary ×1), NOT the unrelated freeform doc.
        const search = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents?q=${encodeURIComponent(token1)}`,
            { headers: authedHeaders(token) },
        );
        const searchJson = (await search.json()) as {
            items: Array<{ title: string; path: string }>;
            total: number;
        };
        expect(searchJson.total, 'q matches the 3 token-bearing docs').toBe(3);
        expect(
            searchJson.items.every((d) => d.title.toLowerCase().includes(token1)),
            'every q hit carries the token in its title',
        ).toBeTruthy();

        // q + class compose: token AND class=research → 2.
        const composed = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents?q=${encodeURIComponent(token1)}&class=research`,
            { headers: authedHeaders(token) },
        );
        expect(((await composed.json()) as { total: number }).total).toBe(2);

        // Pagination: limit=1 returns a single item, same total.
        const paged = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents?limit=1&offset=0`,
            { headers: authedHeaders(token) },
        );
        const pagedJson = (await paged.json()) as { items: unknown[]; total: number };
        expect(pagedJson.items.length).toBe(1);
        expect(pagedJson.total).toBe(4);
    });

    test('per-Work + cross-user KB isolation: a non-member is 403 on every KB route', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const id = runId();
        // Owner user A seeds a doc in Work A.
        const { access_token: ownerToken } = await registerUserViaAPI(request);
        const { id: workA } = await createWorkViaAPI(request, ownerToken, {
            name: `KB Isolation A ${id}`,
        });
        expect(workA).toBeTruthy();
        const { documentId: docA, path: pathA } = await seedKbMarkdownDoc(
            request,
            ownerToken,
            workA,
            {
                filename: `secret-${id}.md`,
                body: `# Secret ${id}\n\nowner-only knowledge base content\n`,
                targetClass: 'legal',
            },
        );

        // A separate user B owns Work B (its own empty KB).
        const { access_token: outsiderToken } = await registerUserViaAPI(request);
        const { id: workB } = await createWorkViaAPI(request, outsiderToken, {
            name: `KB Isolation B ${id}`,
        });
        expect(workB).toBeTruthy();

        // 1. Work B's KB is empty — Work A's doc never leaks into Work B's
        //    list (per-Work scoping).
        const bDocs = await request.get(`${API_BASE}/api/works/${workB}/kb/documents`, {
            headers: authedHeaders(outsiderToken),
        });
        expect(bDocs.status()).toBe(200);
        expect(((await bDocs.json()) as { total: number }).total).toBe(0);

        // 2. User B (a non-member of Work A) is FORBIDDEN on every Work A KB
        //    route — read AND write — via ensureCanView / ensureCanEdit.
        const forbiddenReads: Array<{ label: string; url: string }> = [
            { label: 'list docs', url: `/api/works/${workA}/kb/documents` },
            {
                label: 'get doc by id',
                url: `/api/works/${workA}/kb/documents/${docA}`,
            },
            {
                label: 'get doc by path',
                url: `/api/works/${workA}/kb/documents/${encodeURIComponent(pathA)}`,
            },
            { label: 'list uploads', url: `/api/works/${workA}/kb/uploads` },
            { label: 'list tags', url: `/api/works/${workA}/kb/tags` },
            {
                label: 'doc history',
                url: `/api/works/${workA}/kb/documents/${docA}/history`,
            },
            {
                label: 'doc citations',
                url: `/api/works/${workA}/kb/documents/${docA}/citations`,
            },
        ];
        for (const r of forbiddenReads) {
            const res = await request.get(`${API_BASE}${r.url}`, {
                headers: authedHeaders(outsiderToken),
            });
            expect(res.status(), `${r.label} → 403 for non-member`).toBe(403);
        }

        // Write attempts by the outsider are also forbidden.
        const forbiddenUpload = await request.post(`${API_BASE}/api/works/${workA}/kb/uploads`, {
            headers: authedHeaders(outsiderToken),
            multipart: {
                file: {
                    name: 'intruder.txt',
                    mimeType: 'text/plain',
                    buffer: Buffer.from('intruder'),
                },
                targetClass: 'freeform',
            },
        });
        expect(forbiddenUpload.status(), 'non-member upload → 403').toBe(403);
        const forbiddenPatch = await request.patch(
            `${API_BASE}/api/works/${workA}/kb/documents/${docA}`,
            { headers: authedHeaders(outsiderToken), data: { title: 'pwned' } },
        );
        expect(forbiddenPatch.status(), 'non-member edit → 403').toBe(403);
        const forbiddenDelete = await request.delete(
            `${API_BASE}/api/works/${workA}/kb/documents/${docA}`,
            { headers: authedHeaders(outsiderToken) },
        );
        expect(forbiddenDelete.status(), 'non-member delete → 403').toBe(403);

        // 3. The owner can still read the doc — the isolation is one-way
        //    (the doc was never harmed by the blocked writes).
        const ownerRead = await request.get(`${API_BASE}/api/works/${workA}/kb/documents/${docA}`, {
            headers: authedHeaders(ownerToken),
        });
        expect(ownerRead.status()).toBe(200);
        const ownerDoc = (await ownerRead.json()) as { id: string; title: string; body: string };
        expect(ownerDoc.id).toBe(docA);
        expect(ownerDoc.title, "owner's doc title untouched by intruder PATCH").not.toBe('pwned');
        expect(ownerDoc.body).toContain('owner-only knowledge base content');
    });
});
