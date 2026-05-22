'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

/**
 * EW-641 Phase 1B/d row 2 — Knowledge Base page shell.
 *
 * Three-pane layout (tree | editor | AI side panel) following the same
 * dashboard look-and-feel as the activity / items pages. Subsequent
 * tickets fill each pane in turn:
 *  - Row 3: tree panel reads `GET /api/works/:id/kb/documents`
 *  - Row 4-6: nested editor route + Tiptap + autosave
 *  - Row 7-8: drag-drop upload zone + classify modal
 *  - Row 13: per-document side panel (status / tags / lock controls)
 *
 * This component intentionally only renders placeholders so the route
 * is browsable on `develop` before any of the data-fetching panes land.
 * Each pane uses an `aria-label` derived from a translation key so the
 * follow-up tickets can replace the body without breaking selectors
 * used by the upcoming Playwright e2e suite (A12 / A13 / A14).
 */
interface KbShellProps {
    workId: string;
}

export function KbShell({ workId }: KbShellProps) {
    const t = useTranslations('dashboard.workDetail.kb');

    return (
        <div className="flex flex-col gap-4" data-testid="kb-shell" data-work-id={workId}>
            <header className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark/70">
                    {t('subtitle')}
                </p>
            </header>

            <div
                className={cn(
                    'grid gap-4',
                    // Single-column on small screens, three-pane from md up.
                    'grid-cols-1 md:grid-cols-[minmax(220px,260px)_minmax(0,1fr)_minmax(240px,300px)]',
                )}
            >
                <KbPanePlaceholder
                    testId="kb-tree"
                    title={t('panes.tree.title')}
                    body={t('panes.tree.empty')}
                />

                <KbPanePlaceholder
                    testId="kb-editor"
                    title={t('panes.editor.title')}
                    body={t('panes.editor.empty')}
                    minHeightClass="min-h-[24rem]"
                />

                <KbPanePlaceholder
                    testId="kb-ai-panel"
                    title={t('panes.ai.title')}
                    body={t('panes.ai.empty')}
                />
            </div>
        </div>
    );
}

interface KbPanePlaceholderProps {
    testId: string;
    title: string;
    body: string;
    minHeightClass?: string;
}

function KbPanePlaceholder({ testId, title, body, minHeightClass }: KbPanePlaceholderProps) {
    return (
        <section
            data-testid={testId}
            aria-label={title}
            className={cn(
                'rounded-lg border border-dashed border-border dark:border-border-dark',
                'bg-card/30 dark:bg-card-primary-dark/20',
                'p-4 flex flex-col gap-2',
                minHeightClass,
            )}
        >
            <h2 className="text-sm font-medium text-text dark:text-text-dark">{title}</h2>
            <p className="text-sm text-text-muted dark:text-text-muted-dark/60">{body}</p>
        </section>
    );
}
