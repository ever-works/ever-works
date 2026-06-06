import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { kbAPI } from '@/lib/api/kb';
import { ApiResponseError } from '@/lib/api/server-api';
import { cn } from '@/lib/utils/cn';
import { MarkdownPreview } from '@/components/works/detail/items/MarkdownPreview';
import { rewriteWikilinks } from '@/components/works/detail/kb/wikilink-md';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

interface EmbeddedKbViewerProps {
    /** Owning Work ID — required so wikilinks resolve to the right KB. */
    workId: string;
    /** Either the document UUID or the canonical `<class>/<slug>.md` path. */
    idOrPath: string;
    /** Optional wrapper className for layout integration. */
    className?: string;
}

/**
 * EW-643 Phase 3 slice 4c — embedded, read-only KB document viewer.
 *
 * Server component. Fetches the document via the existing `kbAPI`
 * helper (server-only) and renders a compact card meant to be embedded
 * anywhere in the workbench (mission detail, agent transcripts,
 * comparison panes, the new `/works/[id]/kb/[...path]/page.tsx`
 * dedicated route page below, etc.).
 *
 * Differences from the workbench `KbDocumentView` editor surface:
 *  - Always read-only. No lock/override controls.
 *  - Compact card layout (no inherited-banner / no editor scaffolding).
 *  - Renders wikilinks as Next.js `<Link>` (client-side nav) instead of
 *    the plain anchors the editor preview surfaces.
 *  - Returns `null` on 404 so callers can `notFound()` themselves; other
 *    backend errors propagate so the host error boundary shows.
 *
 * Stable selectors for e2e suites:
 *  - `data-testid="embedded-kb-viewer"` (root card)
 *  - `data-testid="embedded-kb-viewer-title"`
 *  - `data-testid="embedded-kb-viewer-body"`
 *  - `data-testid="embedded-kb-viewer-tags"`
 *  - `data-testid="embedded-kb-viewer-lock"` (only when `doc.locked`)
 */
export async function EmbeddedKbViewer({ workId, idOrPath, className }: EmbeddedKbViewerProps) {
    const t = await getTranslations('dashboard.workDetail.kb');

    let doc: KbDocumentBodyDto;
    try {
        doc = await kbAPI.getDocument(workId, idOrPath);
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 404) {
            return null;
        }
        throw error;
    }

    const rewrittenBody = doc.body ? rewriteWikilinks(doc.body, workId) : '';

    return (
        <article
            data-testid="embedded-kb-viewer"
            data-kb-doc-id={doc.id}
            data-kb-doc-path={doc.path}
            className={cn(
                // Compact card matches the rest of the workbench surfaces
                // (KbDocumentView, KbSidePanel) but trimmed of editor
                // chrome — neutral border, subtle card fill, no shadows.
                'rounded-lg border border-border dark:border-border-dark',
                'bg-card/60 dark:bg-card-primary-dark/30',
                'p-4 flex flex-col gap-3',
                className,
            )}
        >
            <header className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                    <span
                        className={cn(
                            'px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide',
                            'bg-primary/10 text-primary dark:bg-primary/20',
                        )}
                        data-kb-class={doc.class}
                    >
                        {t(`classes.${doc.class}`)}
                    </span>
                    {doc.locked ? (
                        <span
                            data-testid="embedded-kb-viewer-lock"
                            data-kb-lock-mode={doc.lockMode ?? undefined}
                            className="px-2 py-0.5 rounded-full text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            title={t(`lock.${doc.lockMode ?? 'full'}`)}
                        >
                            🔒 {t(`lock.${doc.lockMode ?? 'full'}`)}
                        </span>
                    ) : null}
                    <span className="ml-auto font-mono text-[11px] text-text-muted dark:text-text-muted-dark/60 truncate max-w-[60%]">
                        {doc.path}
                    </span>
                </div>
                <h3
                    data-testid="embedded-kb-viewer-title"
                    className="text-base font-semibold text-text dark:text-text-dark"
                >
                    {doc.title || doc.path}
                </h3>
                {doc.description ? (
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark/80">
                        {doc.description}
                    </p>
                ) : null}
            </header>

            <div
                data-testid="embedded-kb-viewer-body"
                className={cn(
                    'rounded-md border border-border/60 dark:border-border-dark/60',
                    'bg-card/70 dark:bg-card-primary-dark/10 p-3 overflow-auto',
                    'max-h-[32rem]',
                )}
            >
                {rewrittenBody.trim().length > 0 ? (
                    <MarkdownPreview content={rewrittenBody} />
                ) : (
                    <p className="text-xs italic text-text-muted dark:text-text-muted-dark/60">
                        {t('document.emptyBody')}
                    </p>
                )}
            </div>

            {doc.tags && doc.tags.length > 0 ? (
                <ul
                    data-testid="embedded-kb-viewer-tags"
                    className="flex flex-wrap gap-1.5"
                    aria-label={t('document.tagsLabel')}
                >
                    {doc.tags.map((tag) => (
                        <li key={tag}>
                            <Link
                                href={`/works/${encodeURIComponent(workId)}/kb?tag=${encodeURIComponent(tag)}`}
                                className={cn(
                                    'inline-block px-2 py-0.5 rounded-full text-[10px]',
                                    'bg-card-hover dark:bg-card-primary-dark/40',
                                    'text-text-muted dark:text-text-muted-dark/70',
                                    'hover:text-primary dark:hover:text-primary',
                                    'transition-colors',
                                )}
                            >
                                #{tag}
                            </Link>
                        </li>
                    ))}
                </ul>
            ) : null}
        </article>
    );
}
