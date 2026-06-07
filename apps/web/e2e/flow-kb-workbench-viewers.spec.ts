import { test, expect } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createWorkViaAPI, loginViaAPI } from './helpers/api';
import { seedKbBinaryDoc } from './helpers/kb-fixtures';

/**
 * EW-641 slice D — workbench-route viewer dispatcher acceptance.
 *
 * The catch-all workbench route
 * (`/{locale}/works/[id]/kb/[...path]/page.tsx`) now branches on
 * `upload.mimeType` and hands non-Markdown docs to
 * `<KbDocumentViewerSwitch>` (wrapped in a `<SizeThresholdGate>`).
 * This spec drives the route end-to-end through the real
 * authenticated UI and asserts:
 *  - PDF upload → `kb-pdf-viewer` mounts in the workbench centre.
 *  - Image upload → `kb-image-viewer` mounts.
 *  - Video upload → `kb-video-viewer` mounts.
 *  - An over-cap upload (via `seedKbBinaryDoc` of a large PNG above
 *    the slice-D 10 MiB image cap) renders the size-blocked banner
 *    INSTEAD of the inner image viewer.
 *
 * Skip-gate: gated by `KB_E2E_LIVE_SKIP=1` (mirrors
 * `flow-kb-workbench-shell.spec.ts`) — the spec needs a reachable
 * in-process `/api/works/:id/kb/uploads` endpoint, which the
 * default sqlite CI env serves.
 */

const KB_E2E_LIVE_SKIP = process.env.KB_E2E_LIVE_SKIP === '1';

function runId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Minimal valid PNG byte header + a tiny IDAT — same fixture as flow-kb-viewers-media.spec.ts. */
const TINY_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
    'hex',
);

/** Build a real PDF via pdf-lib. */
async function makePdf(): Promise<Buffer> {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('KB workbench viewer fixture.', { x: 50, y: 720, size: 18, font });
    return Buffer.from(await doc.save());
}

/** Build PNG bytes padded out to `targetBytes` — incompressible random tail keeps it big. */
async function makeFatPng(targetBytes: number): Promise<Buffer> {
    const { randomBytes } = await import('node:crypto');
    const head = TINY_PNG;
    const padLen = Math.max(0, targetBytes - head.length);
    return Buffer.concat([head, randomBytes(padLen)]);
}

test.describe('Flow — KB workbench inline viewer dispatcher', () => {
    test.beforeEach(() => {
        test.skip(
            KB_E2E_LIVE_SKIP,
            'KB_E2E_LIVE_SKIP=1: workbench viewer flow needs the in-process /api/works/:id/kb/uploads endpoint.',
        );
    });

    test('PDF upload → kb-pdf-viewer mounts in the workbench center pane', async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB workbench viewer pdf ${id}`,
        });
        const seeded2 = await seedKbBinaryDoc(request, access_token, workId, {
            filename: `wb-pdf-${id}.pdf`,
            mimeType: 'application/pdf',
            body: await makePdf(),
        });

        await page.goto(`/en/works/${workId}/kb/${seeded2.path}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByTestId('kb-workbench-document-header')).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByTestId('kb-pdf-viewer')).toBeVisible({ timeout: 30_000 });
        // The Tiptap editor must NOT mount for a binary doc.
        await expect(page.getByTestId('kb-workbench-editor-textarea')).toHaveCount(0);
    });

    test('image upload → kb-image-viewer mounts inline (under cap)', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB workbench viewer img ${id}`,
        });
        const seeded2 = await seedKbBinaryDoc(request, access_token, workId, {
            filename: `wb-img-${id}.png`,
            mimeType: 'image/png',
            body: TINY_PNG,
        });

        await page.goto(`/en/works/${workId}/kb/${seeded2.path}`, {
            waitUntil: 'domcontentloaded',
        });
        const viewer = page.getByTestId('kb-image-viewer');
        await expect(viewer).toBeVisible({ timeout: 60_000 });
        await expect(viewer).toHaveAttribute('data-mode', 'inline');
    });

    test('video upload → kb-video-viewer mounts inline', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB workbench viewer vid ${id}`,
        });
        const seeded2 = await seedKbBinaryDoc(request, access_token, workId, {
            filename: `wb-vid-${id}.mp4`,
            mimeType: 'video/mp4',
            body: Buffer.from('tiny-fake-mp4-bytes'),
        });

        await page.goto(`/en/works/${workId}/kb/${seeded2.path}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByTestId('kb-video-viewer')).toBeVisible({ timeout: 60_000 });
    });

    test('image upload above slice-D 10 MiB cap → size-blocked banner replaces the viewer', async ({
        page,
        request,
    }) => {
        test.setTimeout(240_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB workbench viewer sized-out ${id}`,
        });
        // 11 MiB image — over the 10 MiB workbench gate.
        const fatPng = await makeFatPng(11 * 1024 * 1024 + 1024);
        const seeded2 = await seedKbBinaryDoc(request, access_token, workId, {
            filename: `wb-fat-${id}.png`,
            mimeType: 'image/png',
            body: fatPng,
        });

        await page.goto(`/en/works/${workId}/kb/${seeded2.path}`, {
            waitUntil: 'domcontentloaded',
        });
        const blocked = page.getByTestId('kb-workbench-size-blocked');
        await expect(blocked).toBeVisible({ timeout: 60_000 });
        // The image viewer must NOT have mounted.
        await expect(page.getByTestId('kb-image-viewer')).toHaveCount(0);
        // Download anchor is present.
        await expect(page.getByTestId('kb-workbench-size-blocked-download')).toBeVisible();
    });
});
