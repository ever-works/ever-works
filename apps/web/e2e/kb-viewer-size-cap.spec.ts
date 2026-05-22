import { test, expect } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createWorkViaAPI, loginViaAPI } from './helpers/api';
import { seedKbBinaryDoc } from './helpers/kb-fixtures';

/**
 * EW-641 Phase 1B/d row 21c — A14 acceptance e2e (viewer size caps).
 *
 * Drives the per-MIME viewer dispatcher (row 21b) end-to-end:
 *
 *  A14.1 — PDF under the 30 MiB inline cap: seed a tiny valid PDF byte
 *    stub via the public upload endpoint, navigate to the per-doc
 *    editor route, assert that `KbPdfViewer` mounts in `data-mode="inline"`
 *    (the lazy-loaded iframe canvas — we only check the dispatcher's
 *    outer-container state, not the PDF.js render, so this stays fast
 *    and stable on CI).
 *
 *  A14.2 — XLSX over the 5 MiB inline cap: seed a 6 MiB zero-filled
 *    buffer (passes the upload endpoint's 200 MiB cap, fails the
 *    KbXlsxViewer's 5 MiB viewer-side threshold), navigate, assert
 *    that `KbXlsxViewer` mounts in `data-mode="download"` AND the
 *    `kb-xlsx-download-fallback` card is visible.
 *
 * The viewer dispatcher lives in
 * `apps/web/src/app/[locale]/(dashboard)/works/[id]/kb/[...path]/page.tsx`
 * — it fetches the source upload row when `doc.sourceUploadId` is set,
 * runs `pickKbViewer(upload.mimeType)`, and dispatches to the matching
 * `Kb{Pdf,Xlsx,Docx,Image,Video,Audio}Viewer`. URL points at the
 * row-21a download proxy (`/api/works/:id/kb/uploads/:uploadId/download`).
 *
 * Lives in `apps/web/e2e/` so the existing `e2e.yml` workflow picks it
 * up on push to develop / stage / main. Authenticated by the shared
 * `storageState` from `global-setup.ts` (the chromium project's
 * `testIgnore` regex does not enumerate `kb-*`).
 */

const PDF_MIME = 'application/pdf';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Minimal valid PDF byte stub. Browsers + pdf-parse accept this as a
 * "1 page, empty content stream" PDF. Plenty for the dispatcher test —
 * we're asserting on the outer container's `data-mode` attribute, not
 * on the rendered PDF content.
 */
const MINIMAL_PDF_BYTES = Buffer.from(
    '%PDF-1.4\n1 0 obj<<>>endobj\nxref\n0 1\n0000000000 65535 f\ntrailer<<>>\n%%EOF\n',
    'utf8',
);

test.describe('Knowledge Base — A14 viewer size caps', () => {
    test('PDF under 30 MiB renders inline via KbPdfViewer', async ({ page, request }) => {
        test.setTimeout(180_000);

        const testUser = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: testUser.email,
            password: testUser.password,
        });

        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB PDF inline ${runId}`,
        });
        expect(workId, 'createWorkViaAPI must return a non-empty work id').toBeTruthy();

        const { path: docPath } = await seedKbBinaryDoc(request, access_token, workId, {
            filename: `kb-a14-pdf-${runId}.pdf`,
            mimeType: PDF_MIME,
            body: MINIMAL_PDF_BYTES,
        });
        expect(docPath).toMatch(/\.pdf$/);

        await page.goto(`/en/works/${workId}/kb/${docPath}`, { waitUntil: 'domcontentloaded' });

        const pdfViewer = page.locator('[data-testid="kb-pdf-viewer"]');
        await expect(pdfViewer).toBeVisible({ timeout: 60_000 });
        await expect(pdfViewer).toHaveAttribute('data-mode', 'inline');
        // Confirm the download fallback did NOT render — the viewer's
        // inline branch chose KbPdfViewerCanvas (next/dynamic), not the
        // download-fallback card.
        await expect(page.locator('[data-testid="kb-pdf-download-fallback"]')).toHaveCount(0);
    });

    test('XLSX over 5 MiB shows download fallback via KbXlsxViewer', async ({ page, request }) => {
        test.setTimeout(180_000);

        const testUser = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: testUser.email,
            password: testUser.password,
        });

        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB XLSX over-cap ${runId}`,
        });
        expect(workId).toBeTruthy();

        // 6 MiB zero-filled — accepted by the 200 MiB upload cap, exceeds
        // KbXlsxViewer's 5 MiB viewer-side threshold. We don't need a
        // real workbook because the dispatcher decides on `mimeType` +
        // `fileSize` BEFORE the canvas runs `exceljs.xlsx.load()`. The
        // download-fallback card renders purely from the size check.
        const xlsxBuffer = Buffer.alloc(6 * 1024 * 1024, 0);
        const { path: docPath } = await seedKbBinaryDoc(request, access_token, workId, {
            filename: `kb-a14-xlsx-${runId}.xlsx`,
            mimeType: XLSX_MIME,
            body: xlsxBuffer,
        });
        expect(docPath).toMatch(/\.xlsx$/);

        await page.goto(`/en/works/${workId}/kb/${docPath}`, { waitUntil: 'domcontentloaded' });

        const xlsxViewer = page.locator('[data-testid="kb-xlsx-viewer"]');
        await expect(xlsxViewer).toBeVisible({ timeout: 60_000 });
        await expect(xlsxViewer).toHaveAttribute('data-mode', 'download');
        await expect(page.locator('[data-testid="kb-xlsx-download-fallback"]')).toBeVisible({
            timeout: 10_000,
        });
        // The download anchor's href must point at the row-21a download
        // proxy so the operator's click streams the bytes back through
        // the same CSP+nosniff-pinned route.
        const downloadLink = page.locator('[data-testid="kb-xlsx-download-link"]');
        await expect(downloadLink).toBeVisible();
        await expect(downloadLink).toHaveAttribute(
            'href',
            new RegExp(`/api/works/${workId}/kb/uploads/[^/]+/download$`),
        );
    });
});
