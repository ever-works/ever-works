import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { kbAPI } from '@/lib/api/kb';
import { ApiResponseError } from '@/lib/api/server-api';
import { KbShell } from '@/components/works/detail/kb/KbShell';
import { KbTreePanel } from '@/components/works/detail/kb/KbTreePanel';
import { KbDocumentView } from '@/components/works/detail/kb/KbDocumentView';
import { KbEditor } from '@/components/works/detail/kb/KbEditor';
import { KbSidePanel } from '@/components/works/detail/kb/KbSidePanel';
import { KbUploadZone } from '@/components/works/detail/kb/KbUploadZone';

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
 * the `activePath` prop. The editor pane shows the doc via
 * `<KbDocumentView>` (read-only Markdown for now; row 5 swaps that for
 * the Tiptap-based editor + autosave).
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

    // Also fetch the tree list so the left pane is populated. A
    // failure here is non-fatal — the editor pane still renders.
    const list = await Promise.all([workAPI.get(id), kbAPI.listDocuments(id, { limit: 200 })])
        .then(([, docs]) => docs)
        .catch((error) => {
            console.error('[kb-tree] failed to list KB documents:', error);
            return { items: [], total: 0 };
        });

    // Full-lock docs (`locked && lockMode === 'full'`) stay on the
    // read-only viewer so accidental edits don't bounce off the API
    // with a 403. `additions-only` locks still render the editor; the
    // server enforces the actual restriction on save (row 14 surfaces
    // an explicit UI for this — for now we trust the API's response).
    const fullyLocked = doc.locked && doc.lockMode === 'full';

    return (
        <div className="flex flex-col gap-4">
            <KbUploadZone workId={id} targetClass={doc.class} />
            <KbShell
                workId={id}
                treeSlot={<KbTreePanel workId={id} documents={list.items} activePath={doc.path} />}
                editorSlot={
                    fullyLocked ? <KbDocumentView doc={doc} /> : <KbEditor workId={id} doc={doc} />
                }
                asideSlot={<KbSidePanel doc={doc} />}
            />
        </div>
    );
}
