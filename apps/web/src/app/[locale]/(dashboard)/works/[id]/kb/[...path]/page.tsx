import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { kbAPI } from '@/lib/api/kb';
import { ApiResponseError } from '@/lib/api/server-api';
import { WorkbenchShell } from '@/components/kb/workbench/WorkbenchShell';
import { WorkbenchUploadCoordinator } from '@/components/kb/workbench/WorkbenchUploadCoordinator';
import { KbDocumentHeader } from '@/components/kb/workbench/KbDocumentHeader';
import { TiptapEditor } from '@/components/kb/workbench/TiptapEditor';
import { KbMetadataPanel } from '@/components/kb/workbench/KbMetadataPanel';
import { KbDocumentViewerSwitch } from '@/components/kb/workbench/KbDocumentViewerSwitch';
import { KbSearchPalette } from '@/components/kb/workbench/KbSearchPalette';
import type { KbUploadDto } from '@ever-works/contracts';

type Params = {
    params: Promise<{ id: string; path: string[]; locale: string }>;
};

/**
 * Joins the Next.js catch-all `path` segments into the slash-separated
 * doc path the API uses. Each segment is already URL-decoded by Next.
 *
 * Security: reject empty, `.`, and `..` segments to prevent path-traversal
 * payloads reaching the KB API (defense-in-depth — backend should also
 * validate, but the web layer provides an explicit first-line guard).
 */
function joinPath(segments: string[]): string {
    return segments.filter((s) => s.length > 0 && s !== '.' && s !== '..').join('/');
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
    const { id, path } = await params;
    const t = await getTranslations('dashboard.workDetail.kb');
    const joined = joinPath(path);

    if (!joined) {
        return { title: t('workbench.metaTitle') };
    }

    try {
        const doc = await kbAPI.getDocument(id, joined);
        return { title: `${doc.title || joined} — ${t('workbench.metaTitle')}` };
    } catch {
        return { title: t('workbench.metaTitle') };
    }
}

/**
 * EW-641 slice A — KB workbench document detail page.
 *
 * Server component. Catch-all route `/works/[id]/kb/[...path]` —
 * accepts a `path` array because canonical doc paths look like
 * `brand/voice.md` (the `<class>/<slug>.md` shape from spec §8).
 * We rejoin with `/` and ship the value to the API verbatim; the
 * backend resolves either a UUID or the canonical path.
 *
 * Renders the three-pane workbench shell:
 *  - Left: `KbTreePanel` with `currentDocPath` so the active row is
 *    pre-highlighted and its class group opens by default.
 *  - Center: `KbDocumentHeader` (title + chips) over `TiptapEditor`
 *    (WYSIWYG, autosaves on debounce).
 *  - Right: `KbMetadataPanel` — slice B side panel covering class /
 *    tags / description / status / lock / language / source plus a
 *    disabled "View Git history" placeholder for slice E.
 *
 * 404 semantics: any non-404 backend error bubbles to the dashboard
 * error boundary; a 404 from the doc fetch renders Next's `not-found`.
 */
export default async function WorkKnowledgeBaseDocumentPage({ params }: Params) {
    const { id, path } = await params;
    const joined = joinPath(path);

    if (!joined) {
        notFound();
    }

    try {
        const workResponse = await workAPI.get(id);
        if (!workResponse?.work) notFound();
    } catch {
        notFound();
    }

    let doc;
    try {
        doc = await kbAPI.getDocument(id, joined);
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 404) {
            notFound();
        }
        throw error;
    }

    // Slice D — when the doc was derived from a binary upload (a PDF,
    // image, etc.), fetch the upload row so we can dispatch to the
    // matching inline viewer. `KbDocumentDto` doesn't carry the MIME
    // type or byte size; both live on `KbUploadDto`. We swallow a
    // 404 here (orphaned `sourceUploadId`) and fall through to the
    // Markdown editor so the doc still loads in a degraded but
    // usable state.
    let upload: KbUploadDto | null = null;
    if (doc.sourceUploadId) {
        try {
            upload = await kbAPI.getUpload(id, doc.sourceUploadId);
        } catch (error) {
            if (error instanceof ApiResponseError && error.statusCode === 404) {
                upload = null;
            } else {
                throw error;
            }
        }
    }

    const bareMime = (upload?.mimeType ?? '').split(';')[0].trim().toLowerCase();
    const useInlineViewer =
        upload !== null &&
        bareMime.length > 0 &&
        bareMime !== 'text/markdown' &&
        bareMime !== 'text/plain';
    const downloadUrl = upload ? `/api/works/${id}/kb/uploads/${upload.id}/download` : undefined;

    return (
        <>
            <KbSearchPalette workId={id} />
            <WorkbenchShell
                left={<WorkbenchUploadCoordinator workId={id} currentDocPath={doc.path} />}
                center={
                    <div className="flex h-full flex-col">
                        <KbDocumentHeader workId={id} document={doc} />
                        {useInlineViewer && upload ? (
                            <div className="flex-1 overflow-auto p-4">
                                <KbDocumentViewerSwitch
                                    workId={id}
                                    document={doc}
                                    mimeType={upload.mimeType}
                                    fileSize={upload.fileSize}
                                    filename={upload.originalFilename}
                                    downloadUrl={downloadUrl}
                                />
                            </div>
                        ) : (
                            <TiptapEditor workId={id} document={doc} initialBody={doc.body} />
                        )}
                    </div>
                }
                right={<KbMetadataPanel workId={id} document={doc} />}
            />
        </>
    );
}
