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
 * Build a minimal-but-valid PDF (Catalog → Pages → one empty Page) with
 * correctly computed xref byte offsets. The agent-side extractor uses
 * `pdfjs-dist`, which rejects PDFs without a real `/Root` reference and
 * a populated `/Pages` tree (hence the previous "Invalid root reference"
 * failure with a hand-rolled 73-byte stub). We're asserting only on the
 * viewer dispatcher's `data-mode`, not on the rendered PDF, so a tiny
 * 1-page empty body is plenty.
 */
function makeMinimalValidPdf(): Buffer {
    const header = '%PDF-1.4\n';
    const obj1 = '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n';
    const obj2 = '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n';
    const obj3 = '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n';

    let pos = header.length;
    const off1 = pos;
    pos += obj1.length;
    const off2 = pos;
    pos += obj2.length;
    const off3 = pos;
    pos += obj3.length;
    const xrefPos = pos;

    const pad = (n: number): string => n.toString().padStart(10, '0');
    // Each xref entry must be exactly 20 bytes (10-digit offset + ' ' +
    // 5-digit generation + ' ' + 'n'/'f' + ' ' + '\n'). pdfjs validates
    // the slot width and bails if it sees fewer bytes.
    const xref =
        `xref\n0 4\n0000000000 65535 f \n` +
        `${pad(off1)} 00000 n \n` +
        `${pad(off2)} 00000 n \n` +
        `${pad(off3)} 00000 n \n`;
    const trailer = `trailer<</Size 4/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;

    return Buffer.from(header + obj1 + obj2 + obj3 + xref + trailer, 'utf8');
}

/**
 * Build a real `.xlsx` byte buffer (ZIP-of-XML, exceljs-emitted) padded
 * with incompressible random base64 cells until the file is at least
 * `targetBytes`. The agent's buffer extractor parses every uploaded
 * `application/vnd...sheet` body via `exceljs.xlsx.load()`, so handing
 * it `Buffer.alloc(6 * 1024 * 1024, 0)` produced a "not a zip file"
 * extraction failure that left the upload row with `document: null`.
 *
 * For the A14.2 dispatcher test we just need a workbook that:
 *  - extracts cleanly (so the API returns `{upload, document}`),
 *  - is > KbXlsxViewer's 5 MiB inline cap (so the viewer mounts in
 *    `data-mode="download"`).
 */
async function makeOversizeXlsx(targetBytes: number): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const { randomBytes } = await import('node:crypto');
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Sheet1');
    // 64 KiB random → ~88 KiB base64 per cell, ZIP-incompressible.
    const CHUNK = 64 * 1024;
    const rowsNeeded = Math.ceil(targetBytes / CHUNK) + 8;
    for (let i = 0; i < rowsNeeded; i++) {
        sheet.getCell(`A${i + 1}`).value = randomBytes(CHUNK).toString('base64');
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
}

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
            body: makeMinimalValidPdf(),
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

        // Real exceljs-emitted workbook padded with random base64 cells
        // to ~6 MiB. Has to be a valid XLSX so the agent's buffer
        // extractor (`exceljs.xlsx.load()`) doesn't reject the upload —
        // a zero-filled buffer used to fail extraction with "not a zip
        // file" and leave the upload row with `document: null`. The
        // viewer dispatcher then decides on `fileSize` AFTER the row
        // exists, so a slightly oversized real workbook is the cleanest
        // way to drive the > 5 MiB download-fallback branch.
        const xlsxBuffer = await makeOversizeXlsx(6 * 1024 * 1024);
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
