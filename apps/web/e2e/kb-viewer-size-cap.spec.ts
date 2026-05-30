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
 * Build a minimal-but-valid PDF with one page that draws "Hello, World!"
 * via a Type1 Helvetica font. The agent's pdfjs-dist extractor needs
 * BOTH (a) a parseable `/Catalog` + `/Pages` tree and (b) at least one
 * page that yields > 0 characters when text-extracted — otherwise the
 * extractor reports `"KB PDF extraction produced no text — likely an
 * image-only PDF; OCR is Phase 3"` and marks the upload row failed.
 *
 * We're asserting only on the viewer dispatcher's `data-mode`, not on
 * the rendered PDF, so a single 13-character page is plenty.
 */
function makeMinimalValidPdf(): Buffer {
    // Page content stream: BT/ET delimit a text block; Tf sets font;
    // Td positions the cursor; Tj draws the literal string.
    const streamData = 'BT /F1 24 Tf 100 700 Td (Hello, World!) Tj ET\n';
    const objs: string[] = [
        '<</Type/Catalog/Pages 2 0 R>>',
        '<</Type/Pages/Kids[3 0 R]/Count 1>>',
        '<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/MediaBox[0 0 612 792]/Contents 4 0 R>>',
        `<</Length ${streamData.length}>>\nstream\n${streamData}endstream`,
        '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ];

    const header = '%PDF-1.4\n';
    let body = header;
    const offsets: number[] = [];
    for (let i = 0; i < objs.length; i++) {
        offsets.push(body.length);
        body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xrefPos = body.length;

    const pad = (n: number): string => n.toString().padStart(10, '0');
    // Each xref entry must be exactly 20 bytes (10-digit offset + ' ' +
    // 5-digit generation + ' ' + 'n'/'f' + ' ' + '\n'). pdfjs validates
    // the slot width and bails if it sees fewer bytes.
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) {
        xref += `${pad(o)} 00000 n \n`;
    }
    const trailer = `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;

    return Buffer.from(body + xref + trailer, 'utf8');
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
    // exceljs ships as CJS; under Node ESM `await import('exceljs')`
    // returns `{ default: ExcelJSObject }` and the `.Workbook` constructor
    // lives on the default export — `new ExcelJS.Workbook()` directly on
    // the namespace throws "is not a constructor". The production
    // `load-exceljs-workbook.ts` only works because webpack flattens the
    // interop in the browser bundle; in Playwright (raw Node) we have to
    // unwrap the default ourselves. Fall through to the namespace for
    // ESM-native builds that do not wrap.
    interface ExcelJsCtorHost {
        Workbook: new () => {
            addWorksheet(name: string): {
                getCell(addr: string): { value: string };
            };
            xlsx: { writeBuffer(): Promise<ArrayBuffer> };
        };
    }
    const mod = (await import('exceljs')) as unknown as {
        default?: ExcelJsCtorHost;
    } & ExcelJsCtorHost;
    const ExcelJS: ExcelJsCtorHost = mod.default ?? mod;
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
