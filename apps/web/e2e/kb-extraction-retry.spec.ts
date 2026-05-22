import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { TEST_USER } from './helpers/test-user';
import { seedKbSkippedUpload } from './helpers/kb-fixtures';

/**
 * EW-641 Phase 1B/d row 23 — A16 acceptance e2e (failed/skipped extraction
 * + retry).
 *
 * Exercises the retry path through the public surface:
 *
 *   1. Seed an upload with `application/octet-stream` — no extractor
 *      route, so `KnowledgeBaseService.createUpload` lands the upload
 *      with `extractionStatus='skipped'` + `document: null` and emits
 *      `kb_upload_extraction_skipped` to the activity log.
 *   2. Confirm the GET shape: `extractionStatus='skipped'`,
 *      `extractedDocumentId` is null/undefined.
 *   3. Call `POST /api/works/:id/kb/uploads/:uploadId/retry-extraction`
 *      (the manager+ endpoint from `kb.controller.ts`). The
 *      `KnowledgeBaseService.retryUploadExtraction` flow re-reads the
 *      bytes from storage, re-routes through the buffer extractor;
 *      `application/octet-stream` still has no extractor route, so it
 *      stays skipped + emits another `kb_upload_extraction_skipped`.
 *   4. Confirm the activity log now has ≥ 2 `kb_upload_extraction_skipped`
 *      rows for this `(workId, uploadId)` correlation pair — proving the
 *      retry endpoint actually runs the same code path.
 *
 * Pure backend assertion via Playwright's `request` fixture (same shape
 * as A15). The retry endpoint is the manager+ surface; the TEST_USER
 * created the Work via `createWorkViaAPI`, so they own it.
 *
 * For full A16 ("actually-failed PDF" path), a future PR can extend this
 * spec with an `__TEST_FORCE_EXTRACT_FAIL__` env-flag injector that
 * makes the buffer extractor throw mid-route. That requires a small
 * test-only seam in `KnowledgeBaseBufferExtractorService` and is out of
 * scope for this PR (per the row 23 plan in
 * Workspace/knowledge/runbooks/KNOWLEDGE_BASE_HANDOFF.md).
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

test.describe('Knowledge Base — A16 retry-extraction', () => {
    test('octet-stream upload stays skipped after retry; activity log records both attempts', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const { access_token } = await loginViaAPI(request, {
            email: TEST_USER.email,
            password: TEST_USER.password,
        });

        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Retry Extract ${runId}`,
        });
        expect(workId).toBeTruthy();

        // 1. Seed an upload the buffer-extractor has no route for. The
        //    bytes don't have to be valid anything — `createUpload`
        //    persists them, marks the row skipped, and emits the
        //    activity row without trying to parse the content.
        const opaqueBody = Buffer.from(`KB A16 opaque payload ${runId}`, 'utf8');
        const { uploadId, extractionStatus } = await seedKbSkippedUpload(
            request,
            access_token,
            workId,
            { filename: `kb-a16-${runId}.bin`, body: opaqueBody },
        );
        expect(extractionStatus).toBe('skipped');

        // 2. Verify the GET surface matches the create response: the
        //    upload row is persisted with `extractionStatus='skipped'`
        //    and no `extractedDocumentId`.
        const beforeRes = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads/${uploadId}`,
            { headers: authedHeaders(access_token) },
        );
        expect(beforeRes.status(), 'GET upload after create').toBe(200);
        const beforeBody = (await beforeRes.json()) as {
            extractionStatus?: string;
            extractedDocumentId?: string | null;
        };
        expect(beforeBody.extractionStatus).toBe('skipped');
        expect(beforeBody.extractedDocumentId ?? null).toBeNull();

        // 3. POST retry-extraction. The endpoint requires manager+ role
        //    on the Work; createWorkViaAPI made TEST_USER the owner.
        const retryRes = await request.post(
            `${API_BASE}/api/works/${workId}/kb/uploads/${uploadId}/retry-extraction`,
            { headers: authedHeaders(access_token) },
        );
        expect(retryRes.status(), 'POST retry-extraction').toBe(200);
        const retryBody = (await retryRes.json()) as {
            upload?: { extractionStatus?: string };
            document?: unknown;
        };
        // The retry runs through `extractAndMaterialize`; with an
        // unsupported MIME the doc is null and the upload status stays
        // 'skipped'. The activity row count grows by one.
        expect(retryBody.upload?.extractionStatus).toBe('skipped');
        expect(retryBody.document ?? null).toBeNull();

        // 4. The activity log should now have at least TWO
        //    `kb_upload_extraction_skipped` rows correlated to this
        //    upload — one from createUpload, one from
        //    retryUploadExtraction. Poll because `ActivityLogService.log`
        //    is fire-and-forget on some paths (lesson learned in A15).
        const skippedRows = await pollForSkippedRows(
            request,
            access_token,
            workId,
            uploadId,
            2,
            30_000,
            1_000,
        );
        expect(skippedRows.length).toBeGreaterThanOrEqual(2);
        for (const row of skippedRows) {
            expect(row.metadata?.uploadId).toBe(uploadId);
        }
    });
});

/**
 * Poll `GET /api/activity-log?workId=<id>&actionType=kb_upload_extraction_skipped`
 * until at least `minCount` rows for the target `uploadId` appear.
 * Returns the matching rows sorted by `createdAt` ascending.
 */
async function pollForSkippedRows(
    request: Parameters<typeof loginViaAPI>[0],
    token: string,
    workId: string,
    uploadId: string,
    minCount: number,
    budgetMs: number,
    intervalMs: number,
): Promise<ActivityRow[]> {
    const deadline = Date.now() + budgetMs;
    let lastBody = '';
    while (Date.now() < deadline) {
        const res = await request.get(
            `${API_BASE}/api/activity-log?workId=${encodeURIComponent(workId)}&actionType=kb_upload_extraction_skipped&limit=100`,
            { headers: authedHeaders(token) },
        );
        if (res.ok()) {
            const body = (await res.json()) as ActivityListResponse;
            const ours = body.activities.filter((r) => r.metadata?.uploadId === uploadId);
            if (ours.length >= minCount) {
                return ours.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
            }
            lastBody = JSON.stringify({ total: body.total, oursCount: ours.length });
        } else {
            lastBody = await res.text();
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
        `pollForSkippedRows: ${budgetMs}ms budget exhausted before ${minCount} kb_upload_extraction_skipped rows for upload ${uploadId} appeared; last body: ${lastBody}`,
    );
}
