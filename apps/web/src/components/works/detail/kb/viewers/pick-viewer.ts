/**
 * EW-641 Phase 1B/d row 21b — pure helper that decides which KB viewer
 * to mount for a given upload MIME type.
 *
 * Keeping this a side-effect-free pure function (no React import, no
 * filesystem / network access) so:
 *  - The doc detail page can call it during server-render without
 *    triggering a client-boundary mount.
 *  - Vitest can exercise every branch (and the unknown-mime fallback)
 *    with a plain TypeScript spec — no jsdom needed.
 *
 * Returns `'text'` for markdown / plain / unknown MIMEs so the existing
 * `KbEditor` / `KbDocumentView` rendering path stays the default. Binary
 * viewers (`KbPdfViewer`, `KbXlsxViewer`, `KbDocxViewer`, `KbImageViewer`,
 * `KbVideoViewer`, `KbAudioViewer`) take over only when the MIME is
 * unambiguously theirs.
 *
 * Caller note: dispatch on a non-`'text'` result ONLY when the doc has a
 * non-null `sourceUploadId` (otherwise there's no URL to point the viewer
 * at). Markdown / plain MIMEs always fall through to `'text'` because the
 * KB stores the rendered body in `doc.body` and there is nothing to
 * stream — the editor renders that body directly.
 */

export type KbViewerKind = 'pdf' | 'xlsx' | 'docx' | 'image' | 'video' | 'audio' | 'text';

const PDF_MIME = 'application/pdf';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Pick the viewer kind from a MIME type.
 *
 * - `null` / `undefined` / empty → `'text'` (treated as "no binary
 *   payload — render the markdown body").
 * - Case-insensitive on the bare MIME; parameters after `;` (e.g.
 *   `text/html; charset=utf-8`) are stripped before matching so a
 *   server-side `Content-Type` header round-tripped through the upload
 *   row still classifies correctly.
 * - CSV is intentionally NOT mapped to `xlsx` — the XLSX viewer parses
 *   workbook formats via `exceljs`, which would reject a plain CSV. CSV
 *   falls through to `'text'` and the markdown editor renders it as a
 *   monospaced block.
 */
export function pickKbViewer(mimeType: string | null | undefined): KbViewerKind {
    if (!mimeType) return 'text';
    const bare = mimeType.split(';')[0].trim().toLowerCase();
    if (bare.length === 0) return 'text';
    if (bare === PDF_MIME) return 'pdf';
    if (bare === XLSX_MIME) return 'xlsx';
    if (bare === DOCX_MIME) return 'docx';
    if (bare.startsWith('image/')) return 'image';
    if (bare.startsWith('video/')) return 'video';
    if (bare.startsWith('audio/')) return 'audio';
    return 'text';
}
