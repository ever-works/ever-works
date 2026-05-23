'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { overrideInheritedKbDocumentAction } from '@/app/actions/works/kb-document';
import { ROUTES } from '@/lib/constants';

interface KbInheritedOverrideButtonProps {
    workId: string;
    orgId: string;
    /** The inherited doc's id or canonical path; either is accepted by the server action. */
    idOrPath: string;
}

/**
 * EW-641 Phase 2/e row 38d — "Override locally" CTA on the inherited
 * KB doc detail view.
 *
 * Replaces the row-38c disabled placeholder button. Same
 * `data-testid="kb-inherited-override-cta"` selector + same i18n
 * label so the row 38e Playwright e2e (and existing row-38c unit
 * tests on selector shape) keep passing.
 *
 * Flow on click:
 *   1. `useTransition` flips the button to a busy state so users get
 *      immediate feedback (server actions can take a beat).
 *   2. Calls `overrideInheritedKbDocumentAction` which forks the
 *      inherited doc into a Work-scope row at the same path/class
 *      and revalidates the affected paths.
 *   3. On success, `router.push` jumps to the new Work-scope detail
 *      URL (now fully editable + autosave). The inherited section
 *      in the tree disappears at next render because
 *      `resolveInheritableDocuments` prefers Work overrides by path.
 *   4. On failure, surface a small inline error message in the
 *      banner — the user can retry without leaving the page.
 *
 * Client-side only (the parent `<KbDocumentView>` is a server
 * component but renders this lazily inside the banner). The action
 * itself runs server-side via Next.js server actions.
 */
export function KbInheritedOverrideButton({
    workId,
    orgId,
    idOrPath,
}: KbInheritedOverrideButtonProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const handleClick = () => {
        setError(null);
        startTransition(async () => {
            const result = await overrideInheritedKbDocumentAction({
                workId,
                orgId,
                idOrPath,
            });
            // `ActionResult.data` is typed as optional in the shared
            // envelope; the server action always returns it on
            // success, but TS can't narrow through that — guard
            // defensively so a future contract change doesn't crash
            // the navigation.
            if (result.success && result.data) {
                router.push(`${ROUTES.DASHBOARD_WORK_KB(workId)}/${result.data.path}`);
            } else if (!result.success) {
                setError(result.error || t('inherited.overrideErrorFallback'));
            } else {
                setError(t('inherited.overrideErrorFallback'));
            }
        });
    };

    return (
        <>
            <button
                type="button"
                onClick={handleClick}
                disabled={isPending}
                data-testid="kb-inherited-override-cta"
                data-busy={isPending ? 'true' : undefined}
                className={cn(
                    'ml-auto rounded-md px-3 py-1 text-xs font-medium',
                    'bg-amber-500/20 dark:bg-amber-400/20',
                    'text-amber-900 dark:text-amber-100',
                    'border border-amber-500/40 dark:border-amber-400/40',
                    'transition-opacity',
                    isPending
                        ? 'cursor-wait opacity-60'
                        : 'hover:bg-amber-500/30 dark:hover:bg-amber-400/30',
                )}
            >
                {isPending ? t('inherited.overrideCtaBusy') : t('inherited.overrideCta')}
            </button>
            {error ? (
                <p
                    data-testid="kb-inherited-override-error"
                    role="alert"
                    className="basis-full text-xs text-red-700 dark:text-red-300"
                >
                    {error}
                </p>
            ) : null}
        </>
    );
}
