import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { seedKbMarkdownDoc } from './helpers/kb-fixtures';

/**
 * EW-641 Phase 1B/d row 24 — A17 acceptance e2e (SHA-256 dedup).
 *
 * `KnowledgeBaseService.createUpload` computes SHA-256 over the buffer
 * and calls `WorkKnowledgeUploadRepository.findBySha256(workId, sha256)`
 * BEFORE touching storage. On hit, it short-circuits the
 * persist-storage / create-row / extract+materialize pipeline:
 *
 *   await this.recordUploadActivity(...KB_UPLOAD_DEDUPED, {
 *     uploadId: existing.id, originalFilename, sha256,
 *   });
 *   return { upload: existing, document: null };
 *
 * The acceptance test confirms the user-visible side of that:
 *
 *  1. Upload a markdown buffer once via `seedKbMarkdownDoc`. The first
 *     call lands a fresh `kb_upload_created` + `kb_upload_extracted` +
 *     `kb_document_created` triple (text-passthrough path).
 *  2. Re-POST the SAME bytes + MIME directly to
 *     `/api/works/:id/kb/uploads`. The dedup branch fires; the response
 *     must contain the FIRST upload's `id` and `document: null` (no new
 *     row, no new doc).
 *  3. Activity log polled for `kb_upload_deduped` filtered by
 *     `workId=<id>` must show exactly ONE row, correlated by
 *     `metadata.uploadId === <first upload's id>`. The
 *     `kb_upload_created` count must stay at exactly 1 (dedup
 *     short-circuits before that emit).
 *
 * Pure backend assertion via Playwright's `request` fixture (same shape
 * as A15 / A16). Reuses the `loginViaAPI` + `createWorkViaAPI` +
 * `seedKbMarkdownDoc` pattern from rows 19 / 20 / 22.
 */

interface ActivityRow {
    actionType: string;
    workId: string | null;
    createdAt: string;
    metadata: Record<string, unknown> | null;
}

interface ActivityListResponse {
    activities: ActivityRow[];
    total: number;
}

interface UploadResponseShape {
    upload?: { id?: string } | null;
    document?: { id?: string; path?: string } | null;
}

test.describe('Knowledge Base — A17 SHA-256 dedup', () => {
    test('re-uploading the same bytes returns the existing upload + emits one kb_upload_deduped row', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const testUser = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: testUser.email,
            password: testUser.password,
        });

        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Dedup ${runId}`,
        });
        expect(workId).toBeTruthy();

        // Stable buffer — the SHA-256 hash drives the dedup branch, so
        // the SECOND POST must use byte-identical content (Buffer.from
        // with the same string + utf8 encoding is deterministic).
        const filename = `kb-a17-${runId}.md`;
        const bodyText = `# A17 dedup ${runId}\n\nbody for the sha256 dedup spec\n`;

        // 1. First upload — text passthrough so we also confirm the
        //    real markdown doc is created (proves the original upload
        //    fell into the create-row + extract+materialize branch, not
        //    something weird like another short-circuit).
        const first = await seedKbMarkdownDoc(request, access_token, workId, {
            filename,
            body: bodyText,
        });
        expect(first.documentId).toBeTruthy();
        expect(first.path).toMatch(/\.md$/);

        // 2. Second upload — SAME bytes, SAME MIME. Bypass the helper
        //    because `seedKbMarkdownDoc` insists on `document` being
        //    non-null; the dedup branch returns `document: null`.
        const secondRes = await request.post(`${API_BASE}/api/works/${workId}/kb/uploads`, {
            headers: authedHeaders(access_token),
            multipart: {
                file: {
                    name: filename,
                    mimeType: 'text/markdown',
                    buffer: Buffer.from(bodyText, 'utf8'),
                },
                targetClass: 'knowledge',
            },
        });
        expect(secondRes.status(), 'POST second upload (dedup)').toBe(201);
        const secondBody = (await secondRes.json()) as UploadResponseShape;

        // The first upload's id is in the markdown helper's response
        // shape... but `seedKbMarkdownDoc` only returns documentId/path.
        // Recover the upload id by reading the upload row that owns the
        // first document — `kbAPI.getDocument` returns sourceUploadId,
        // and the activity log already correlates via uploadId. Easier:
        // assert the SECOND response's `upload.id` matches the upload
        // metadata.uploadId from the kb_upload_created activity row.
        const firstUploadId = await fetchFirstUploadId(request, access_token, workId);
        expect(firstUploadId, 'first upload id from activity log').toBeTruthy();

        expect(secondBody.upload?.id, 'dedup must return the existing upload row').toBe(
            firstUploadId,
        );
        expect(secondBody.document ?? null, 'dedup must NOT create a new document').toBeNull();

        // 3. Activity log: exactly one `kb_upload_deduped`, correlated by
        //    metadata.uploadId, AND `kb_upload_created` stayed at one.
        const allRows = await pollActivityLog(
            request,
            access_token,
            workId,
            ['kb_upload_created', 'kb_upload_deduped'],
            30_000,
            1_000,
        );
        const dedupRows = allRows.filter((r) => r.actionType === 'kb_upload_deduped');
        const createdRows = allRows.filter((r) => r.actionType === 'kb_upload_created');
        expect(dedupRows.length, 'exactly one kb_upload_deduped row').toBe(1);
        expect(createdRows.length, 'kb_upload_created stayed at one — dedup short-circuited').toBe(
            1,
        );
        expect(dedupRows[0].metadata?.uploadId).toBe(firstUploadId);
    });
});

/**
 * Read the activity log for the `kb_upload_created` row associated with
 * the fresh workId — that's where the agent service stamps the first
 * upload's id. Used by the spec to correlate the dedup return value
 * without depending on the API helper response shape (the markdown
 * helper only returns documentId/path).
 */
async function fetchFirstUploadId(
    request: Parameters<typeof loginViaAPI>[0],
    token: string,
    workId: string,
): Promise<string | undefined> {
    // Poll briefly — the `kb_upload_created` activity write goes through
    // `ActivityLogService.log` (fire-and-forget on some paths), same as
    // the A15 / A16 specs.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const res = await request.get(
            `${API_BASE}/api/activity-log?workId=${encodeURIComponent(workId)}&actionType=kb_upload_created&limit=10`,
            { headers: authedHeaders(token) },
        );
        if (res.ok()) {
            const body = (await res.json()) as ActivityListResponse;
            const row = body.activities.find((r) => r.actionType === 'kb_upload_created');
            const uploadId = row?.metadata?.uploadId;
            if (typeof uploadId === 'string' && uploadId.length > 0) {
                return uploadId;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return undefined;
}

/**
 * Poll the activity-log endpoint until at least one row for every
 * `kindsToInclude` action type appears. Returns all matching rows
 * sorted by `createdAt` ascending. Mirrors the helper used by the A15
 * spec, with a stricter "include" filter so the caller can count
 * occurrences per kind.
 */
async function pollActivityLog(
    request: Parameters<typeof loginViaAPI>[0],
    token: string,
    workId: string,
    kindsToInclude: readonly string[],
    budgetMs: number,
    intervalMs: number,
): Promise<ActivityRow[]> {
    const include = new Set(kindsToInclude);
    const deadline = Date.now() + budgetMs;
    let lastBody = '';
    while (Date.now() < deadline) {
        const res = await request.get(
            `${API_BASE}/api/activity-log?workId=${encodeURIComponent(workId)}&limit=100`,
            { headers: authedHeaders(token) },
        );
        if (res.ok()) {
            const body = (await res.json()) as ActivityListResponse;
            const filtered = body.activities.filter((r) => include.has(r.actionType));
            const kindsSeen = new Set(filtered.map((r) => r.actionType));
            if (kindsSeen.size === include.size) {
                return filtered.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
            }
            lastBody = JSON.stringify({ total: body.total, kindsSeen: [...kindsSeen] });
        } else {
            lastBody = await res.text();
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
        `pollActivityLog: ${budgetMs}ms budget exhausted before all kinds (${[...include].join(', ')}) appeared; last body: ${lastBody}`,
    );
}
