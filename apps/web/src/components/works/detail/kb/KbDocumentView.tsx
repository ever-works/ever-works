import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils/cn';
import { MarkdownPreview } from '@/components/works/detail/items/MarkdownPreview';
import { KbInheritedOverrideButton } from './KbInheritedOverrideButton';
import { rewriteWikilinks } from './wikilink-md';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

interface KbDocumentViewProps {
    doc: KbDocumentBodyDto;
    /**
     * EW-641 Phase 2/e row 38c — render the "Inherited from
     * organization" banner above the doc header. When `true`, the
     * component is the read-only org-overlay viewer: editor surface
     * stays mounted as `KbDocumentView` (already non-editable), and
     * the banner explains the tier + offers the "Override locally"
     * CTA (live server action wired in row 38d).
     *
     * Defaults to `false` so every existing call site keeps the
     * legacy read-only behaviour (full-lock docs, etc.).
     */
    isInherited?: boolean;
    /**
     * EW-641 Phase 2/e row 38d — Work id that owns this detail
     * route. Required (only) when `isInherited` is true so the
     * inline `KbInheritedOverrideButton` can submit the
     * `overrideInheritedKbDocumentAction` against the right Work.
     * Defaults to `null` to keep every legacy call site (full-lock
     * docs, etc.) unchanged.
     */
    workId?: string | null;
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
 * EW-641 Phase 2/e row 38c — when `isInherited` is true, also renders
 * an "Inherited from organization" banner above the header with an
 * "Override locally" placeholder CTA. The component itself stays
 * read-only either way (the editor swap happens at the parent route
 * level by selecting `KbDocumentView` vs `KbEditor`).
 *
 * Selectors locked for the upcoming Playwright e2e suite (A12-A17):
 *  - `data-testid="kb-editor"` (root, matches the placeholder slot
 *    in `KbShell` so tests that pre-date this PR keep working)
 *  - `data-testid="kb-document-title"`
 *  - `data-testid="kb-document-meta"` (chip row)
 *  - `data-testid="kb-document-body"` (Markdown render wrapper)
 *  - `data-testid="kb-inherited-banner"` (row 38c — only when
 *    `isInherited` is true; row 38d adds the working override CTA
 *    inside this banner)
 */
export async function KbDocumentView({
    doc,
    isInherited = false,
    workId = null,
}: KbDocumentViewProps) {
    const t = await getTranslations('dashboard.workDetail.kb');

    return (
        <section
            data-testid="kb-editor"
            data-inherited={isInherited ? 'true' : undefined}
            aria-label={t('panes.editor.title')}
            className={cn(
                'rounded-lg border border-border dark:border-border-dark',
                'bg-card/50 dark:bg-card-primary-dark/30',
                'p-4 flex flex-col gap-3 min-h-[24rem]',
            )}
        >
            {isInherited ? (
                <aside
                    data-testid="kb-inherited-banner"
                    role="note"
                    aria-label={t('inherited.bannerLabel')}
                    className={cn(
                        'rounded-md border border-amber-500/30 dark:border-amber-400/30',
                        'bg-amber-500/10 dark:bg-amber-400/10',
                        'p-3 flex flex-wrap items-center gap-2 text-sm',
                        'text-amber-900 dark:text-amber-100',
                    )}
                >
                    <span
                        aria-hidden="true"
                        className="text-base leading-none"
                        data-testid="kb-inherited-banner-icon"
                    >
                        🔒
                    </span>
                    <div className="flex flex-col gap-0.5 min-w-0">
                        <span data-testid="kb-inherited-banner-title" className="font-medium">
                            {t('inherited.bannerTitle')}
                        </span>
                        <span
                            data-testid="kb-inherited-banner-description"
                            className="text-xs text-amber-900/80 dark:text-amber-100/80"
                        >
                            {t('inherited.bannerDescription')}
                        </span>
                    </div>
                    {/*
                     * EW-641 Phase 2/e row 38d — "Override locally" CTA.
                     * Renders the live client-side button when we have
                     * the workId + orgId needed to submit the server
                     * action; falls back to a disabled placeholder when
                     * a caller renders `isInherited` without those
                     * (legacy / tests). The placeholder keeps the
                     * `data-testid` stable for any selector that
                     * pre-dates this wiring.
                     */}
                    {workId && doc.organizationId ? (
                        <KbInheritedOverrideButton
                            workId={workId}
                            orgId={doc.organizationId}
                            idOrPath={doc.id}
                        />
                    ) : (
                        <button
                            type="button"
                            disabled
                            data-testid="kb-inherited-override-cta"
                            className={cn(
                                'ml-auto rounded-md px-3 py-1 text-xs font-medium',
                                'bg-amber-500/20 dark:bg-amber-400/20',
                                'text-amber-900 dark:text-amber-100',
                                'cursor-not-allowed opacity-60',
                                'border border-amber-500/40 dark:border-amber-400/40',
                            )}
                            title={t('inherited.overrideCtaPendingTooltip')}
                        >
                            {t('inherited.overrideCta')}
                        </button>
                    )}
                </aside>
            ) : null}
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
