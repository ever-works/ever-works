import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils/cn';
import { MarkdownPreview } from '@/components/works/detail/items/MarkdownPreview';
import { rewriteWikilinks } from './wikilink-md';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

interface KbDocumentViewProps {
    doc: KbDocumentBodyDto;
}

/**
 * EW-641 Phase 1B/d row 4 — read-only Knowledge Base document view.
 *
 * Server component. Renders the document header (title + class chip +
 * status + lock marker + path) followed by the Markdown body via the
 * existing `MarkdownPreview` client component (`react-markdown` +
 * `remark-gfm`). The editor itself (Tiptap, autosave, dirty/saved
 * pill) arrives in row 5 + 6 — this PR ships the read-only view so
 * deep-linking from the tree works the moment the route lands.
 *
 * Selectors locked for the upcoming Playwright e2e suite (A12-A17):
 *  - `data-testid="kb-editor"` (root, matches the placeholder slot
 *    in `KbShell` so tests that pre-date this PR keep working)
 *  - `data-testid="kb-document-title"`
 *  - `data-testid="kb-document-meta"` (chip row)
 *  - `data-testid="kb-document-body"` (Markdown render wrapper)
 */
export async function KbDocumentView({ doc }: KbDocumentViewProps) {
    const t = await getTranslations('dashboard.workDetail.kb');

    return (
        <section
            data-testid="kb-editor"
            aria-label={t('panes.editor.title')}
            className={cn(
                'rounded-lg border border-border dark:border-border-dark',
                'bg-card/50 dark:bg-card-primary-dark/30',
                'p-4 flex flex-col gap-3 min-h-[24rem]',
            )}
        >
            <header className="flex flex-col gap-2">
                <h2
                    data-testid="kb-document-title"
                    className="text-lg font-semibold text-text dark:text-text-dark"
                >
                    {doc.title || doc.path}
                </h2>
                <div
                    data-testid="kb-document-meta"
                    className="flex items-center gap-2 text-xs flex-wrap"
                >
                    <span
                        className={cn(
                            'px-2 py-0.5 rounded-full font-medium uppercase tracking-wide',
                            'bg-primary/10 text-primary dark:bg-primary/20',
                        )}
                        data-kb-class={doc.class}
                    >
                        {t(`classes.${doc.class}`)}
                    </span>
                    <span
                        className={cn(
                            'px-2 py-0.5 rounded-full',
                            doc.status === 'active'
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : doc.status === 'archived'
                                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                  : 'bg-card-hover dark:bg-card-primary-dark/40 text-text-muted dark:text-text-muted-dark/70',
                        )}
                        data-kb-status={doc.status}
                    >
                        {t(`status.${doc.status}`)}
                    </span>
                    {doc.locked ? (
                        <span
                            className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            data-locked="true"
                            data-kb-lock-mode={doc.lockMode ?? undefined}
                        >
                            🔒 {t(`lock.${doc.lockMode ?? 'full'}`)}
                        </span>
                    ) : null}
                    <span className="ml-auto font-mono text-[11px] text-text-muted dark:text-text-muted-dark/60">
                        {doc.path}
                    </span>
                </div>
                {doc.description ? (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark/80">
                        {doc.description}
                    </p>
                ) : null}
            </header>

            <div
                data-testid="kb-document-body"
                className={cn(
                    'rounded-md border border-border/60 dark:border-border-dark/60',
                    'bg-card/70 dark:bg-card-primary-dark/10 p-4 overflow-auto',
                )}
            >
                {doc.body && doc.body.trim().length > 0 ? (
                    <MarkdownPreview
                        content={doc.workId ? rewriteWikilinks(doc.body, doc.workId) : doc.body}
                    />
                ) : (
                    <p className="text-sm italic text-text-muted dark:text-text-muted-dark/60">
                        {t('document.emptyBody')}
                    </p>
                )}
            </div>
        </section>
    );
}
