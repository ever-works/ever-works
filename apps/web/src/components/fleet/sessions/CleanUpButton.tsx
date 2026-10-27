'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { deleteCheckoutAction } from '@/app/actions/fleet-checkouts';
import { Button } from '@/components/ui/button';
import { sessionGitErrorTitleKey } from './session-git.shared';

/**
 * Session git & actions (FL-06, spec FR-25, S11, U16, §5.7) — **Clean up**
 * on a session card and a checkout row: once the worktree's pull request is
 * merged or closed and no live session uses it, remove the worktree folder
 * through FL-14's delete (its changes-check: `confirm`, or type the folder's
 * name when work would be lost) — the branch is always kept. The platform
 * applies the gate again (`?cleanUp=1`), so a stale screen cannot clean up a
 * worktree that is back in use.
 */
export function CleanUpButton({
    checkoutId,
    branch,
    nodeName,
    onCleaned,
}: {
    checkoutId: string;
    branch: string | null;
    nodeName: string;
    onCleaned?: () => void;
}) {
    const t = useTranslations('fleet.sessionGit.cleanUp');
    const tErrors = useTranslations('fleet.sessionGit.errorTitles');
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<{
        destructive: boolean;
        name: string;
        summary: string | null;
    } | null>(null);
    const [typed, setTyped] = useState('');
    const [done, setDone] = useState(false);

    const run = async (body: { confirm?: boolean; confirmName?: string }) => {
        setBusy(true);
        const result = await deleteCheckoutAction(
            checkoutId,
            { mode: 'delete', ...body },
            { cleanUp: true },
        );
        setBusy(false);
        if (result.success) {
            setConfirm(null);
            setDone(true);
            toast.success(t('done', { branch: branch ?? '—' }));
            onCleaned?.();
            return;
        }
        if (result.code === 'confirmation_required' && result.details) {
            const details = result.details;
            setConfirm({
                destructive: details.class === 'confirm-destructive',
                name: typeof details.name === 'string' ? details.name : '',
                summary: typeof details.summary === 'string' ? details.summary : null,
            });
            return;
        }
        toast.error(
            `${tErrors(sessionGitErrorTitleKey(result.code))}${result.hint ? ` — ${result.hint}` : ''}`,
        );
    };

    if (done) {
        return (
            <span
                className="text-xs text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-clean-up-done"
            >
                {t('done', { branch: branch ?? '—' })}
            </span>
        );
    }
    if (confirm) {
        const allowed = !confirm.destructive || typed.trim() === confirm.name;
        return (
            <span
                className="inline-flex flex-wrap items-center gap-2 text-xs"
                data-testid="fleet-clean-up-confirm"
            >
                <span>
                    {confirm.summary ?? t('confirm', { branch: branch ?? '—', node: nodeName })}
                </span>
                {confirm.destructive ? (
                    <input
                        value={typed}
                        onChange={(event) => setTyped(event.target.value)}
                        placeholder={confirm.name}
                        aria-label={t('typeName', { name: confirm.name })}
                        className="w-32 rounded border border-border dark:border-border-dark bg-transparent px-1.5 py-0.5 font-mono"
                    />
                ) : null}
                <Button
                    size="sm"
                    variant="danger"
                    disabled={busy || !allowed}
                    onClick={() =>
                        void run(
                            confirm.destructive ? { confirmName: typed.trim() } : { confirm: true },
                        )
                    }
                    data-testid="fleet-clean-up-confirm-button"
                >
                    {t('remove')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                    {t('cancel')}
                </Button>
            </span>
        );
    }
    return (
        <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void run({})}
            title={t('title', { branch: branch ?? '—' })}
            data-testid="fleet-clean-up"
        >
            {t('button')}
        </Button>
    );
}
