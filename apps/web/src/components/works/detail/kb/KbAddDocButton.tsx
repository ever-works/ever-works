'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { createKbDocumentAction } from '@/app/actions/works/kb-document';
import { KbAddDocModal, type KbAddDocResult } from './KbAddDocModal';

interface KbAddDocButtonProps {
    workId: string;
}

/**
 * EW-641 KB workbench follow-up — "+ Add" entry point above the KB
 * tree / upload zone.
 *
 * Holds the open/closed state for `KbAddDocModal`, runs the
 * `createKbDocumentAction` server action, and routes the user to the
 * freshly-minted doc's editor route on success. The `useRouter` hook
 * comes from `@/i18n/navigation` so the push keeps the active locale
 * prefix on the catch-all KB route.
 */
export function KbAddDocButton({ workId }: KbAddDocButtonProps) {
    const t = useTranslations('dashboard.workDetail.kb.addDoc');
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const onConfirm = useCallback(
        (result: KbAddDocResult) => {
            setError(null);
            startTransition(async () => {
                const outcome = await createKbDocumentAction({
                    workId,
                    class: result.targetClass,
                    title: result.title,
                    description: result.description.length > 0 ? result.description : null,
                    tags: result.tags,
                });
                if (outcome.success && outcome.data) {
                    setOpen(false);
                    // Land the user inside the Tiptap editor for the new
                    // doc. `useRouter` from `@/i18n/navigation` preserves
                    // the active locale prefix.
                    router.push(`${ROUTES.DASHBOARD_WORK_KB(workId)}/${outcome.data.path}`);
                } else {
                    setError(outcome.error ?? t('errorFallback'));
                }
            });
        },
        [router, t, workId],
    );

    const onCancel = useCallback(() => {
        if (pending) return;
        setOpen(false);
        setError(null);
    }, [pending]);

    return (
        <>
            <Button
                type="button"
                data-testid="kb-add-doc-button"
                onClick={() => setOpen(true)}
                size="sm"
                className={cn('inline-flex items-center gap-1')}
            >
                {t('button')}
            </Button>
            {open ? (
                <KbAddDocModal
                    workId={workId}
                    onConfirm={onConfirm}
                    onCancel={onCancel}
                    busy={pending}
                    error={error}
                />
            ) : null}
        </>
    );
}
