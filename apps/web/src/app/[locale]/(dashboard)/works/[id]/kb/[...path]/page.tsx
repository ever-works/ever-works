import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { kbAPI } from '@/lib/api/kb';
import { ApiResponseError } from '@/lib/api/server-api';
import { WorkbenchShell } from '@/components/kb/workbench/WorkbenchShell';
import { KbTreePanel } from '@/components/kb/workbench/KbTreePanel';
import { KbDocumentHeader } from '@/components/kb/workbench/KbDocumentHeader';
import { MarkdownEditor } from '@/components/kb/workbench/MarkdownEditor';

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
 *  - Center: `KbDocumentHeader` (title + chips) over `MarkdownEditor`
 *    (textarea + live preview, autosaves on debounce).
 *  - Right: empty in slice A — the AI panel lands in Phase 2.
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

    return (
        <WorkbenchShell
            left={<KbTreePanel workId={id} currentDocPath={doc.path} />}
            center={
                <div className="flex h-full flex-col">
                    <KbDocumentHeader workId={id} document={doc} />
                    <MarkdownEditor workId={id} document={doc} initialBody={doc.body} />
                </div>
            }
        />
    );
}
