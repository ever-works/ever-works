'use client';

import { useCallback, useState, useTransition } from 'react';
// EW-641 follow-up — use the locale-aware `useRouter` from
// `@/i18n/navigation` so `router.refresh()` after a lock toggle keeps
// the active locale prefix on the KB detail route.
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { lockKbDocumentAction, unlockKbDocumentAction } from '@/app/actions/works/kb-lock';
import type { KbDocumentBodyDto, KbLockMode } from '@ever-works/contracts';

interface KbLockControlsProps {
    doc: Pick<KbDocumentBodyDto, 'id' | 'workId' | 'path' | 'locked' | 'lockMode'>;
}

type LockState = {
    locked: boolean;
    lockMode: KbLockMode | null;
};

/**
 * EW-641 Phase 1B/d row 14 — lock toggle + mode selector for a KB doc.
 *
 * Replaces the read-only lock chip in `KbSidePanel`. Keeps the
 * `kb-side-panel-lock` test-id stable on the visible badge so Playwright
 * selectors from row 13 keep working, then adds:
 *  - `kb-side-panel-lock-toggle` — Lock / Unlock button
 *  - `kb-side-panel-lock-mode`   — `<select>` (disabled when unlocked or
 *                                  while a mutation is in-flight)
 *
 * Server-side branch already shipped in Phase 1A; this PR adds the
 * Next.js proxies under
 * `apps/web/src/app/api/works/[id]/kb/documents/[docId]/lock/route.ts`
 * + `/unlock/route.ts`, plus matching `kbAPI.lockDocument` /
 * `unlockDocument` helpers and the two server actions in
 * `apps/web/src/app/actions/works/kb-lock.ts`.
 *
 * Optimistic UX: clicking the toggle / changing the mode immediately
 * flips the local `state`. On server error we revert and surface the
 * message via `data-error`. `router.refresh()` after a successful
 * mutation re-renders the server components (tree panel + editor /
 * doc-view branch) so the rest of the UI catches up to the new lock
 * state without a separate refetch.
 */
export function KbLockControls({ doc }: KbLockControlsProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const router = useRouter();
    const [state, setState] = useState<LockState>({
        locked: doc.locked,
        lockMode: doc.lockMode,
    });
    const [error, setError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const onToggle = useCallback(() => {
        const previous = state;
        const nextLocked = !previous.locked;
        // Default the mode to `full` the first time we lock; subsequent
        // re-locks (after an unlock → lock cycle) reuse whatever mode
        // was last chosen.
        const nextMode: KbLockMode = nextLocked ? (previous.lockMode ?? 'full') : 'full';
        setError(null);
        setState({ locked: nextLocked, lockMode: nextLocked ? nextMode : null });

        startTransition(async () => {
            const result = nextLocked
                ? await lockKbDocumentAction({
                      workId: doc.workId ?? '',
                      docId: doc.id,
                      path: doc.path,
                      mode: nextMode,
                  })
                : await unlockKbDocumentAction({
                      workId: doc.workId ?? '',
                      docId: doc.id,
                      path: doc.path,
                  });

            if (!result.success || !result.data) {
                setState(previous);
                setError(result.error ?? 'Lock action failed');
                return;
            }
            // API is the source of truth — sync from the returned row
            // in case a concurrent edit changed mode under us.
            setState({
                locked: result.data.locked,
                lockMode: result.data.lockMode,
            });
            router.refresh();
        });
    }, [state, doc.workId, doc.id, doc.path, router]);

    const onModeChange = useCallback(
        (mode: KbLockMode) => {
            if (!state.locked) return;
            if (mode === state.lockMode) return;
            const previous = state;
            setError(null);
            setState({ locked: true, lockMode: mode });

            startTransition(async () => {
                const result = await lockKbDocumentAction({
                    workId: doc.workId ?? '',
                    docId: doc.id,
                    path: doc.path,
                    mode,
                });
                if (!result.success || !result.data) {
                    setState(previous);
                    setError(result.error ?? 'Lock action failed');
                    return;
                }
                setState({ locked: result.data.locked, lockMode: result.data.lockMode });
                router.refresh();
            });
        },
        [state, doc.workId, doc.id, doc.path, router],
    );

    const lockLabel = state.locked
        ? `🔒 ${t(`lock.${state.lockMode ?? 'full'}`)}`
        : t('sidePanel.unlocked');

    return (
        <div className="flex flex-col gap-2" data-error={error ?? undefined}>
            <span
                data-testid="kb-side-panel-lock"
                data-locked={state.locked ? 'true' : 'false'}
                data-kb-lock-mode={state.lockMode ?? undefined}
                data-pending={isPending ? 'true' : undefined}
                className={cn(
                    'inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs',
                    state.locked
                        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        : 'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70',
                )}
            >
                {lockLabel}
            </span>

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    size="sm"
                    variant={state.locked ? 'ghost' : 'secondary'}
                    onClick={onToggle}
                    disabled={isPending}
                    data-testid="kb-side-panel-lock-toggle"
                    data-action={state.locked ? 'unlock' : 'lock'}
                    aria-busy={isPending ? 'true' : undefined}
                >
                    {state.locked ? t('lockControls.unlock') : t('lockControls.lock')}
                </Button>

                <select
                    data-testid="kb-side-panel-lock-mode"
                    data-kb-lock-mode={state.lockMode ?? undefined}
                    value={state.lockMode ?? 'full'}
                    onChange={(event) => onModeChange(event.target.value as KbLockMode)}
                    disabled={!state.locked || isPending}
                    aria-label={t('lockControls.modeLabel')}
                    className={cn(
                        'rounded border px-2 py-1 text-xs',
                        'border-border bg-card dark:border-border-dark dark:bg-card-primary-dark/40',
                        'text-text-secondary dark:text-text-secondary-dark/80',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                >
                    <option value="full">{t('lock.full')}</option>
                    <option value="additions-only">{t('lock.additions-only')}</option>
                </select>
            </div>

            {error ? (
                <p
                    data-testid="kb-side-panel-lock-error"
                    className="text-xs text-red-600 dark:text-red-400"
                >
                    {error}
                </p>
            ) : null}
        </div>
    );
}
