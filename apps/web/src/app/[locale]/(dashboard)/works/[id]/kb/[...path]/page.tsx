import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { kbAPI } from '@/lib/api/kb';
import { ApiResponseError } from '@/lib/api/server-api';
import { KbShell } from '@/components/works/detail/kb/KbShell';
import { KbTreePanel } from '@/components/works/detail/kb/KbTreePanel';
import { KbDocumentView } from '@/components/works/detail/kb/KbDocumentView';
import { KbEditor } from '@/components/works/detail/kb/KbEditor';
import { KbSearchPalette } from '@/components/works/detail/kb/KbSearchPalette';
import { KbSidePanel } from '@/components/works/detail/kb/KbSidePanel';
import { KbUploadZone } from '@/components/works/detail/kb/KbUploadZone';
import { KbPdfViewer } from '@/components/works/detail/kb/viewers/KbPdfViewer';
import { KbXlsxViewer } from '@/components/works/detail/kb/viewers/KbXlsxViewer';
import { KbDocxViewer } from '@/components/works/detail/kb/viewers/KbDocxViewer';
import { KbImageViewer } from '@/components/works/detail/kb/viewers/KbImageViewer';
import { KbVideoViewer } from '@/components/works/detail/kb/viewers/KbVideoViewer';
import { KbAudioViewer } from '@/components/works/detail/kb/viewers/KbAudioViewer';
import { pickKbViewer, type KbViewerKind } from '@/components/works/detail/kb/viewers/pick-viewer';
import type { KbDocumentBodyDto, KbUploadDto } from '@ever-works/contracts';

type Params = {
    params: Promise<{ id: string; path: string[] }>;
};

/**
 * Joins the Next.js catch-all `path` segments into the slash-separated
 * doc path the API uses. Each segment is already URL-decoded by Next,
 * so we just rejoin and let the API resolve the canonical row.
 */
function joinPath(segments: string[]): string {
    return segments.filter((s) => s.length > 0).join('/');
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
    const { id, path } = await params;
    const t = await getTranslations('dashboard.workDetail.kb');
    const joined = joinPath(path);

    try {
        const doc = await kbAPI.getDocument(id, joined);
        return { title: `${doc.title || joined} — ${t('title')}` };
    } catch {
        return { title: t('title') };
    }
}

/**
 * EW-641 Phase 1B/d row 4 — Knowledge Base document detail page.
 *
 * Catch-all route `/works/[id]/kb/[...path]/page.tsx` — accepts a
 * `path` array because doc paths look like `brand/voice.md` (the
 * canonical `<class>/<slug>.md` shape from spec §8). We rejoin with
 * `/`, ship the value to the API verbatim, and let
 * `KnowledgeBaseService.getDocument` resolve either a UUID or a path.
 *
 * Renders the full three-pane shell so the user keeps the tree on the
 * left while reading: the active row in the tree is highlighted via
 * the `activePath` prop. The editor pane swaps between three modes:
 *  - Full-lock docs render `KbDocumentView` (read-only Markdown).
 *  - Docs sourced from a binary upload (PDF / XLSX / DOCX / image /
 *    video / audio) render the matching viewer from `viewers/` (row
 *    21b dispatcher). The viewer fetches the bytes from the row-21a
 *    `GET /works/:id/kb/uploads/:uploadId/download` endpoint via the
 *    `url` prop.
 *  - Everything else renders the `KbEditor` (Tiptap + autosave).
 *
 * Errors: 404 → `notFound()`; other backend failures bubble to the
 * dashboard error boundary (matches the activity / items pages —
 * intentionally not swallowed so operators see a clear failure mode).
 */
export default async function WorkKnowledgeBaseDocumentPage({ params }: Params) {
    const { id, path } = await params;
    const joined = joinPath(path);

    if (!joined) {
        notFound();
    }

    // Parent layout already verifies the Work exists, so we lean on the
    // doc fetch as the single source of truth for "this URL is valid".
    let doc;
    try {
        doc = await kbAPI.getDocument(id, joined);
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 404) {
            notFound();
        }
        throw error;
    }

    // Tree list + (optional) source-upload row alongside the doc. Tree
    // failures fall back to an empty tree; upload-row failures fall back
    // to the markdown editor path (treat an orphaned `sourceUploadId`
    // as "not a binary doc").
    const upload = await loadSourceUpload(id, doc);
    const list = await Promise.all([workAPI.get(id), kbAPI.listDocuments(id, { limit: 200 })])
        .then(([, docs]) => docs)
        .catch((error) => {
            console.error('[kb-tree] failed to list KB documents:', error);
            return { items: [], total: 0 };
        });

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-end">
                <KbSearchPalette workId={id} />
            </div>
            <KbUploadZone workId={id} targetClass={doc.class} />
            <KbShell
                workId={id}
                treeSlot={<KbTreePanel workId={id} documents={list.items} activePath={doc.path} />}
                editorSlot={renderEditorSlot(id, doc, upload)}
                asideSlot={<KbSidePanel doc={doc} />}
            />
        </div>
    );
}

/**
 * Fetch the source upload row when the doc references one. Returns
 * `null` for org-overlay docs (no upload), AI-generated docs (no
 * upload), or orphaned references (404 from the API — survives the
 * upload-row delete with the doc still present).
 */
async function loadSourceUpload(
    workId: string,
    doc: KbDocumentBodyDto,
): Promise<KbUploadDto | null> {
    if (!doc.sourceUploadId) return null;
    try {
        return await kbAPI.getUpload(workId, doc.sourceUploadId);
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 404) {
            return null;
        }
        // Network / 5xx errors fall back to the markdown path rather
        // than throwing — the editor still works, just without the
        // binary preview. Log so operators see the underlying issue.
        console.error('[kb-viewer] failed to load source upload:', error);
        return null;
    }
}

/**
 * Decide which component renders the editor slot. Full-lock docs stay
 * on the read-only Markdown viewer (row 4); docs whose source upload's
 * MIME maps to a binary viewer mount the matching viewer (row 21b);
 * everything else continues to render the Tiptap editor (row 5).
 *
 * The viewers receive a `url` pointing at the row-21a download proxy.
 * Sandboxing lives on the API response headers (CSP +
 * X-Content-Type-Options: nosniff), so we don't need to add any
 * client-side restrictions here.
 */
function renderEditorSlot(
    workId: string,
    doc: KbDocumentBodyDto,
    upload: KbUploadDto | null,
): ReactNode {
    const fullyLocked = doc.locked && doc.lockMode === 'full';
    if (fullyLocked) {
        return <KbDocumentView doc={doc} />;
    }
    const kind: KbViewerKind = upload ? pickKbViewer(upload.mimeType) : 'text';
    if (upload && kind !== 'text') {
        const url = `/api/works/${workId}/kb/uploads/${upload.id}/download`;
        const sizeBytes = upload.fileSize;
        const filename = upload.originalFilename;
        switch (kind) {
            case 'pdf':
                return <KbPdfViewer url={url} sizeBytes={sizeBytes} filename={filename} />;
            case 'xlsx':
                return <KbXlsxViewer url={url} sizeBytes={sizeBytes} filename={filename} />;
            case 'docx':
                return <KbDocxViewer url={url} sizeBytes={sizeBytes} filename={filename} />;
            case 'image':
                return (
                    <KbImageViewer
                        url={url}
                        sizeBytes={sizeBytes}
                        filename={filename}
                        alt={doc.title || filename}
                    />
                );
            case 'video':
                return (
                    <KbVideoViewer
                        url={url}
                        sizeBytes={sizeBytes}
                        filename={filename}
                        mimeType={upload.mimeType}
                    />
                );
            case 'audio':
                return (
                    <KbAudioViewer
                        url={url}
                        sizeBytes={sizeBytes}
                        filename={filename}
                        mimeType={upload.mimeType}
                    />
                );
        }
    }
    return <KbEditor workId={workId} doc={doc} />;
}
