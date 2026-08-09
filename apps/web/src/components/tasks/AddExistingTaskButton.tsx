'use client';

import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TaskScopeKey } from '@/lib/api/tasks.shared';
import { AssignScopeTaskDialog } from './AssignScopeTaskDialog';

/**
 * The "Add existing" half of a scoped Tasks tab's action pair. Owns only
 * the dialog's open state, so `TasksScopedSection` stays a server
 * component while still offering the picker beside "New Task".
 *
 * Styled as the secondary of the pair (muted label, same box as the
 * "New Task" control): reusing a Task is the cheaper move, but creating
 * one is what an empty Mission actually needs, so create keeps the
 * stronger affordance.
 */
export function AddExistingTaskButton({
    scopeKey,
    scopeId,
}: {
    scopeKey: TaskScopeKey;
    scopeId: string;
}) {
    const t = useTranslations('dashboard.tasksPage.scopedSection');
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-button-primary dark:bg-button-primary-dark text-button-primary-foreground dark:text-button-primary-foreground-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
                <Link2 className="w-3.5 h-3.5" />
                {t('addExisting')}
            </button>
            <AssignScopeTaskDialog
                scopeKey={scopeKey}
                scopeId={scopeId}
                open={open}
                onOpenChange={setOpen}
            />
        </>
    );
}
