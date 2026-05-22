import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils/cn';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

interface KbSidePanelProps {
    doc: KbDocumentBodyDto;
}

/**
 * EW-641 Phase 1B/d row 13 — per-document side panel.
 *
 * Server component slotted via `KbShell.asideSlot`. Surfaces document
 * metadata that doesn't fit naturally in the document header — tags,
 * description, lock state + mode, language, source, word/token counts,
 * and a placeholder "View Git history" affordance that lights up once
 * row 18 wires the `GET /api/works/:id/kb/documents/:docId/history`
 * endpoint.
 *
 * Read-only for this PR: the class chip links to the existing classify
 * modal (row 8) for re-classification, tag editing is deferred to row
 * 14 with the lock UI, and the lock toggle is also row 14. We expose
 * stable selectors now so Playwright A12-A17 can lock onto them and
 * the row 14 PR is purely a behavior addition, not a markup shuffle.
 *
 * Selectors locked for Playwright:
 *  - `data-testid="kb-side-panel"` (root, replaces the placeholder
 *    `kb-ai-panel` slot for doc pages)
 *  - `kb-side-panel-class` (class chip)
 *  - `kb-side-panel-tags` (chip list; empty state when zero tags)
 *  - `kb-side-panel-description`
 *  - `kb-side-panel-status` (status badge)
 *  - `kb-side-panel-lock` (lock indicator; `data-locked` + lock-mode attr)
 *  - `kb-side-panel-language`
 *  - `kb-side-panel-source`
 *  - `kb-side-panel-counts` (word + token counts when known)
 *  - `kb-side-panel-history` (disabled <button> placeholder for row 18)
 */
export async function KbSidePanel({ doc }: KbSidePanelProps) {
    const t = await getTranslations('dashboard.workDetail.kb');

    return (
        <aside
            data-testid="kb-side-panel"
            data-doc-id={doc.id}
            data-doc-path={doc.path}
            aria-label={t('sidePanel.title')}
            className={cn(
                'rounded-lg border border-border dark:border-border-dark',
                'bg-card/50 dark:bg-card-primary-dark/30',
                'p-4 flex flex-col gap-4 text-sm',
            )}
        >
            <header className="flex flex-col gap-0.5">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('sidePanel.title')}
                </h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark/60">
                    {t('sidePanel.subtitle')}
                </p>
            </header>

            <Section title={t('sidePanel.sections.class')}>
                <span
                    data-testid="kb-side-panel-class"
                    data-kb-class={doc.class}
                    className={cn(
                        'inline-flex px-2 py-0.5 rounded-full text-xs font-medium uppercase tracking-wide',
                        'bg-primary/10 text-primary dark:bg-primary/20',
                    )}
                >
                    {t(`classes.${doc.class}`)}
                </span>
            </Section>

            <Section title={t('sidePanel.sections.status')}>
                <span
                    data-testid="kb-side-panel-status"
                    data-kb-status={doc.status}
                    className={cn(
                        'inline-flex px-2 py-0.5 rounded-full text-xs',
                        doc.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : doc.status === 'archived'
                              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                              : 'bg-card-hover dark:bg-card-primary-dark/40 text-text-muted dark:text-text-muted-dark/70',
                    )}
                >
                    {t(`status.${doc.status}`)}
                </span>
            </Section>

            <Section title={t('sidePanel.sections.lock')}>
                <span
                    data-testid="kb-side-panel-lock"
                    data-locked={doc.locked ? 'true' : 'false'}
                    data-kb-lock-mode={doc.lockMode ?? undefined}
                    className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs',
                        doc.locked
                            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                            : 'bg-card-hover dark:bg-card-primary-dark/40 text-text-muted dark:text-text-muted-dark/70',
                    )}
                >
                    {doc.locked
                        ? `🔒 ${t(`lock.${doc.lockMode ?? 'full'}`)}`
                        : t('sidePanel.unlocked')}
                </span>
            </Section>

            <Section title={t('sidePanel.sections.tags')}>
                {doc.tags.length === 0 ? (
                    <p
                        data-testid="kb-side-panel-tags"
                        data-empty="true"
                        className="text-xs italic text-text-muted dark:text-text-muted-dark/60"
                    >
                        {t('sidePanel.emptyTags')}
                    </p>
                ) : (
                    <ul
                        data-testid="kb-side-panel-tags"
                        data-empty="false"
                        className="flex flex-wrap gap-1"
                    >
                        {doc.tags.map((tag) => (
                            <li
                                key={tag}
                                data-kb-tag={tag}
                                className={cn(
                                    'inline-flex px-2 py-0.5 rounded-full text-xs',
                                    'bg-card-hover dark:bg-card-primary-dark/40',
                                    'text-text-secondary dark:text-text-secondary-dark/80',
                                )}
                            >
                                {tag}
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section title={t('sidePanel.sections.description')}>
                {doc.description ? (
                    <p
                        data-testid="kb-side-panel-description"
                        className="text-xs text-text-secondary dark:text-text-secondary-dark/80 leading-relaxed"
                    >
                        {doc.description}
                    </p>
                ) : (
                    <p
                        data-testid="kb-side-panel-description"
                        data-empty="true"
                        className="text-xs italic text-text-muted dark:text-text-muted-dark/60"
                    >
                        {t('sidePanel.emptyDescription')}
                    </p>
                )}
            </Section>

            <div className="grid grid-cols-2 gap-3">
                <Section title={t('sidePanel.sections.language')}>
                    <span
                        data-testid="kb-side-panel-language"
                        data-kb-language={doc.language}
                        className="font-mono text-xs text-text-secondary dark:text-text-secondary-dark/80"
                    >
                        {doc.language}
                    </span>
                </Section>
                <Section title={t('sidePanel.sections.source')}>
                    <span
                        data-testid="kb-side-panel-source"
                        data-kb-source={doc.source}
                        className="text-xs text-text-secondary dark:text-text-secondary-dark/80"
                    >
                        {t(`sidePanel.sources.${doc.source}`)}
                    </span>
                </Section>
            </div>

            {doc.wordCount !== null || doc.tokenCount !== null ? (
                <Section title={t('sidePanel.sections.counts')}>
                    <p
                        data-testid="kb-side-panel-counts"
                        data-word-count={doc.wordCount ?? undefined}
                        data-token-count={doc.tokenCount ?? undefined}
                        className="text-xs text-text-secondary dark:text-text-secondary-dark/80"
                    >
                        {doc.wordCount !== null
                            ? t('sidePanel.wordCount', { count: doc.wordCount })
                            : null}
                        {doc.wordCount !== null && doc.tokenCount !== null ? ' · ' : null}
                        {doc.tokenCount !== null
                            ? t('sidePanel.tokenCount', { count: doc.tokenCount })
                            : null}
                    </p>
                </Section>
            ) : null}

            <Section title={t('sidePanel.sections.history')}>
                <button
                    type="button"
                    data-testid="kb-side-panel-history"
                    data-disabled="true"
                    disabled
                    aria-disabled="true"
                    title={t('sidePanel.historyComingSoon')}
                    className={cn(
                        'inline-flex items-center gap-1 px-2 py-1 rounded text-xs',
                        'border border-border dark:border-border-dark',
                        'bg-card-hover/50 dark:bg-card-primary-dark/40',
                        'text-text-muted dark:text-text-muted-dark/70',
                        'cursor-not-allowed opacity-70',
                    )}
                >
                    {t('sidePanel.viewHistory')}
                </button>
            </Section>
        </aside>
    );
}

interface SectionProps {
    title: string;
    children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
    return (
        <section className="flex flex-col gap-1.5">
            <h3
                className={cn(
                    'text-[11px] font-semibold uppercase tracking-wider',
                    'text-text-muted dark:text-text-muted-dark/70',
                )}
            >
                {title}
            </h3>
            {children}
        </section>
    );
}
