'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { KbHistoryDialog } from './KbHistoryDialog';

interface KbHistoryButtonProps {
    workId: string;
    docId: string;
    path: string;
}

/**
 * EW-641 Phase 1B/d row 18c — KB document history affordance.
 *
 * Replaces the disabled placeholder shipped in row 13 with a real
 * trigger. Preserves the `kb-side-panel-history` test-id so the
 * Playwright selectors locked in row 13 keep working without a
 * markup shuffle.
 */
export function KbHistoryButton({ workId, docId, path }: KbHistoryButtonProps) {
    const t = useTranslations('dashboard.workDetail.kb.sidePanel');
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                type="button"
                data-testid="kb-side-panel-history"
                data-disabled="false"
                onClick={() => setOpen(true)}
                className={cn(
                    'inline-flex items-center gap-1 rounded border px-2 py-1 text-xs',
                    'border-border dark:border-border-dark',
                    'bg-card-hover/50 dark:bg-card-primary-dark/40',
                    'text-text-secondary hover:bg-card-hover dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/60',
                )}
            >
                {t('viewHistory')}
            </button>
            <KbHistoryDialog
                workId={workId}
                docId={docId}
                path={path}
                open={open}
                onClose={() => setOpen(false)}
            />
        </>
    );
}
