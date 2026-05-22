import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { TEST_USER } from './helpers/test-user';
import { seedKbMarkdownDoc } from './helpers/kb-fixtures';

/**
 * EW-641 Phase 1B/d row 22 — A15 acceptance e2e (activity log sequence).
 *
 * Proves the end-to-end activity-log emission chain for a KB markdown
 * upload (text-passthrough MIME → synchronous extract + materialize):
 *
 *   kb_upload_created → kb_upload_extracted → kb_document_created
 *
 * `KnowledgeBaseService.createUpload` calls `recordUploadActivity` three
 * times during the text-passthrough branch (see knowledge-base.service.ts
 * lines 813/1027/1039). The pinned `ActivityActionType` enum count test
 * in apps/api already enforces these kinds exist (PR #917); this spec
 * confirms they actually fire + persist + come back through the read
 * route `GET /api/activity-log?workId=<id>`.
 *
 * Pure backend assertion: uses Playwright's `request` fixture only — no
 * UI navigation. Polls the activity-log endpoint up to 30s @ 1s
 * intervals because the activity-log writes go through
 * `ActivityLogService.log` which is fire-and-forget on some paths;
 * the row may settle a few hundred ms after the upload response returns.
 *
 * Correlation chain (asserted):
 *  - `kb_upload_created`     metadata.uploadId   ↘
 *  - `kb_upload_extracted`   metadata.uploadId   ↗ same uploadId
 *                            metadata.documentId ↘
 *  - `kb_document_created`   metadata.documentId ↗ same documentId
 *
 * Lives in `apps/web/e2e/` so the existing `e2e.yml` workflow picks it
 * up on push to develop.
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

test.describe('Knowledge Base — A15 activity log sequence', () => {
    test('markdown upload emits kb_upload_created → kb_upload_extracted → kb_document_created', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const { access_token } = await loginViaAPI(request, {
            email: TEST_USER.email,
            password: TEST_USER.password,
        });

        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Activity Log ${runId}`,
        });
        expect(workId).toBeTruthy();

        // Markdown is a text-passthrough MIME, so all three activity
        // rows land in the single upload call (no async extraction
        // round-trip to wait on).
        const { documentId } = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `kb-a15-${runId}.md`,
            body: `# A15 ${runId}\n\nbody for the activity log spec\n`,
        });
        expect(documentId).toBeTruthy();

        // Poll the activity-log read endpoint until all three KB rows
        // appear. The agent-side `recordUploadActivity` calls are not
        // explicitly awaited on every path, so allow a 30s budget with
        // 1s intervals — same shape the spec text in row 22 calls out.
        const expectedKinds = [
            'kb_upload_created',
            'kb_upload_extracted',
            'kb_document_created',
        ] as const;

        const rows = await pollForActivities(
            request,
            access_token,
            workId,
            expectedKinds,
            30_000,
            1_000,
        );

        // 1. Exactly one row per kind for this run (the workId is fresh,
        //    so there are no other entries to filter past).
        const byKind = new Map<string, ActivityRow>();
        for (const row of rows) {
            byKind.set(row.actionType, row);
        }
        expect(byKind.size, `expected exactly 3 KB activity rows, got ${rows.length}`).toBe(3);

        const upCreated = byKind.get('kb_upload_created')!;
        const upExtracted = byKind.get('kb_upload_extracted')!;
        const docCreated = byKind.get('kb_document_created')!;

        // 2. Chronological order — createdAt must be non-decreasing in
        //    the emit sequence. `ActivityLogService.log` writes with the
        //    default @CreateDateColumn timestamp + millisecond
        //    resolution; in dev/CI we've seen identical ms on adjacent
        //    rows, so allow `<=` rather than strict `<`.
        const t1 = Date.parse(upCreated.createdAt);
        const t2 = Date.parse(upExtracted.createdAt);
        const t3 = Date.parse(docCreated.createdAt);
        expect(t1).not.toBeNaN();
        expect(t1).toBeLessThanOrEqual(t2);
        expect(t2).toBeLessThanOrEqual(t3);

        // 3. Correlation chain — uploadId carries from `_created` to
        //    `_extracted`; documentId carries from `_extracted` to
        //    `kb_document_created`.
        const uploadId = upCreated.metadata?.uploadId;
        expect(typeof uploadId).toBe('string');
        expect(upExtracted.metadata?.uploadId).toBe(uploadId);
        expect(upExtracted.metadata?.documentId).toBe(documentId);
        expect(docCreated.metadata?.documentId).toBe(documentId);
    });
});

/**
 * Poll `GET /api/activity-log?workId=<id>&limit=100` until every kind
 * in `expectedKinds` is present. Returns the matched rows (one per
 * kind, others ignored). Throws with the last response payload baked
 * into the error message if the budget runs out.
 */
async function pollForActivities(
    request: Parameters<typeof loginViaAPI>[0],
    token: string,
    workId: string,
    expectedKinds: readonly string[],
    budgetMs: number,
    intervalMs: number,
): Promise<ActivityRow[]> {
    const expected = new Set(expectedKinds);
    const deadline = Date.now() + budgetMs;
    let lastBody = '';

    while (Date.now() < deadline) {
        const res = await request.get(
            `${API_BASE}/api/activity-log?workId=${encodeURIComponent(workId)}&limit=100`,
            { headers: authedHeaders(token) },
        );
        if (res.ok()) {
            const body = (await res.json()) as ActivityListResponse;
            const rows = body.activities.filter((r) => expected.has(r.actionType));
            const kindsSeen = new Set(rows.map((r) => r.actionType));
            if (expected.size === kindsSeen.size) {
                // Sort by createdAt ascending so the chronology checks
                // upstream are deterministic regardless of the API's
                // default sort order.
                return rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
            }
            lastBody = JSON.stringify({ total: body.total, kindsSeen: [...kindsSeen] });
        } else {
            lastBody = await res.text();
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
        `pollForActivities: ${budgetMs}ms budget exhausted before all kinds appeared (${[...expected].join(', ')}); last body: ${lastBody}`,
    );
}
