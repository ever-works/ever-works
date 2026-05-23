'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

/**
 * EW-641 Phase 1B/d — Knowledge Base page shell.
 *
 * Three-pane layout (tree | editor | AI side panel) following the same
 * dashboard look-and-feel as the activity / items pages. Subsequent
 * tickets fill each pane in turn:
 *  - Row 3: tree panel reads `GET /api/works/:id/kb/documents` (the
 *    `treeSlot` prop accepts a server-rendered `<KbTreePanel>`)
 *  - Row 4-6: nested editor route + Tiptap + autosave (`editorSlot`)
 *  - Row 7-8: drag-drop upload zone + classify modal
 *  - Row 13: per-document side panel (`asideSlot`)
 *
 * Each pane is a server-component slot so the parent page can do
 * RSC-level data fetching and hand the result down without converting
 * this whole tree to RSC (we want the shell to host client-side state
 * later: dirty/saved indicator, command palette, etc.). When a slot
 * is unset we fall back to the placeholder copy, so the route is
 * still browsable as new panes land incrementally.
 *
 * Selectors (`data-testid="kb-tree" / "kb-editor" / "kb-ai-panel"`)
 * are stable across the placeholder + filled-in pane variants —
 * the upcoming Playwright e2e suite (A12-A17) and the per-pane tests
 * both rely on them.
 */
interface KbShellProps {
    workId: string;
    treeSlot?: ReactNode;
    editorSlot?: ReactNode;
    asideSlot?: ReactNode;
}

export function KbShell({ workId, treeSlot, editorSlot, asideSlot }: KbShellProps) {
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
                {treeSlot ?? (
                    <KbPanePlaceholder
                        testId="kb-tree"
                        title={t('panes.tree.title')}
                        body={t('panes.tree.empty')}
                    />
                )}

                {editorSlot ?? (
                    <KbPanePlaceholder
                        testId="kb-editor"
                        title={t('panes.editor.title')}
                        body={t('panes.editor.empty')}
                        minHeightClass="min-h-[24rem]"
                    />
                )}

                {asideSlot ?? (
                    <KbPanePlaceholder
                        testId="kb-ai-panel"
                        title={t('panes.ai.title')}
                        body={t('panes.ai.empty')}
                    />
                )}
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
