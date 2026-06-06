import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { kbAPI } from '@/lib/api/kb';
import { ApiResponseError } from '@/lib/api/server-api';
import { EmbeddedKbViewer } from '@/components/kb/EmbeddedKbViewer';

type Params = {
    params: Promise<{ id: string; path: string[] }>;
};

/**
 * Joins the Next.js catch-all `path` segments into the slash-separated
 * doc path the API uses. Each segment is already URL-decoded by Next.
 *
 * Security: reject empty, `.`, and `..` segments to prevent path-traversal
 * payloads reaching the KB API (defense-in-depth — backend already
 * validates, but the web layer provides an explicit first-line guard).
 * Mirrors the same helper in the sibling `[...path]/page.tsx`.
 */
function joinPath(segments: string[]): string {
    return segments.filter((s) => s.length > 0 && s !== '.' && s !== '..').join('/');
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
    const { id, path } = await params;
    const t = await getTranslations('dashboard.workDetail.kb');
    const joined = joinPath(path);
    if (!joined) {
        return { title: t('title') };
    }
    try {
        const doc = await kbAPI.getDocument(id, joined);
        return { title: `${doc.title || joined} — ${t('title')}` };
    } catch {
        return { title: t('title') };
    }
}

/**
 * EW-643 Phase 3 slice 4c — embedded KB doc route.
 *
 * Server component. Renders a compact, read-only Markdown view of a KB
 * document using `<EmbeddedKbViewer />`. Distinct from the sibling
 * `kb/[...path]/page.tsx`, which renders the full three-pane editor
 * shell (tree + editor + side panel). This route is the link target
 * agents/transcripts/comparison panes use when they want to deep-link
 * to a KB doc without dragging in the full workbench chrome.
 *
 * 404 semantics: `EmbeddedKbViewer` returns `null` on a 404 from the
 * KB API so the host can decide; here we call `notFound()` directly so
 * Next renders the locale's `not-found.tsx` instead of an empty page.
 */
export default async function EmbeddedKbDocumentPage({ params }: Params) {
    const { id, path } = await params;
    const joined = joinPath(path);

    if (!joined) {
        notFound();
    }

    let exists = true;
    try {
        await kbAPI.getDocument(id, joined);
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 404) {
            exists = false;
        } else {
            throw error;
        }
    }

    if (!exists) {
        notFound();
    }

    return (
        <div className="flex flex-col gap-4 max-w-3xl">
            <EmbeddedKbViewer workId={id} idOrPath={joined} />
        </div>
    );
}
