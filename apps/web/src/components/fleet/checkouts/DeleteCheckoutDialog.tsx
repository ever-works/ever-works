'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetCheckoutView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { deleteCheckoutAction } from '@/app/actions/fleet-checkouts';
import { homeRelativePath } from './checkouts.shared';

/** What the API's first answer (`confirmation_required`) carried. */
export interface CheckoutDeletePreview {
    class: 'confirm' | 'confirm-destructive';
    uncommitted: number;
    unpushedCommits: number;
    name: string;
    summary: string | null;
}

/** Read the preview out of a `confirmation_required` refusal's details. Pure. */
export function readDeletePreview(
    details: Record<string, unknown> | null,
): CheckoutDeletePreview | null {
    if (!details) return null;
    const cls =
        details.class === 'confirm-destructive'
            ? 'confirm-destructive'
            : details.class === 'confirm'
              ? 'confirm'
              : null;
    if (!cls || typeof details.name !== 'string') return null;
    return {
        class: cls,
        uncommitted: typeof details.uncommitted === 'number' ? details.uncommitted : 0,
        unpushedCommits: typeof details.unpushedCommits === 'number' ? details.unpushedCommits : 0,
        name: details.name,
        summary: typeof details.summary === 'string' ? details.summary : null,
    };
}

/**
 * Checkouts on computers (FL-14 P2, spec §5.4, S7, FR-24) — the delete (and
 * forget) confirmation, shown under its row with what the computer says
 * would be lost. Clean: "Delete …/fix-login on build-01? The branch is kept."
 * and one button. Dirty: an amber box with the counts and "Type fix-login to
 * confirm" — the button stays off until the name matches. The computer
 * re-checks on delete and refuses when more would be lost than was shown.
 */
export function DeleteCheckoutDialog({
    row,
    mode,
    preview,
    onDone,
    onCancel,
}: {
    row: FleetCheckoutView;
    mode: 'delete' | 'forget';
    preview: CheckoutDeletePreview;
    onDone: (result: { forgotten: boolean; checkout: FleetCheckoutView | null }) => void;
    onCancel: () => void;
}) {
    const t = useTranslations('fleet.checkouts.deleteDialog');
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const destructive = preview.class === 'confirm-destructive';
    const allowed = !destructive || typed.trim() === preview.name;

    const confirm = async () => {
        if (!allowed) return;
        setBusy(true);
        setError(null);
        const result = await deleteCheckoutAction(row.id, {
            mode,
            ...(destructive ? { confirmName: typed.trim() } : { confirm: true }),
        });
        setBusy(false);
        if (result.success) {
            const data = result.data;
            if ('forgotten' in data) onDone({ forgotten: true, checkout: null });
            else onDone({ forgotten: false, checkout: data });
            return;
        }
        setError(result.hint ?? t('failed'));
    };

    return (
        <div
            role="alertdialog"
            aria-label={t(mode === 'forget' ? 'forgetTitle' : 'title')}
            className="basis-full space-y-2 rounded-md border border-border p-3 text-xs dark:border-border-dark"
            data-testid="fleet-delete-checkout"
            data-class={preview.class}
        >
            {destructive ? (
                <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                    {t('wouldLose', {
                        what: [
                            preview.uncommitted > 0
                                ? t('lostFiles', { count: preview.uncommitted })
                                : null,
                            preview.unpushedCommits > 0
                                ? t('lostCommits', { count: preview.unpushedCommits })
                                : null,
                        ]
                            .filter((part): part is string => part !== null)
                            .join(t('and')),
                    })}
                </p>
            ) : null}
            <p>
                {preview.summary ??
                    t(mode === 'forget' ? 'forgetSummary' : 'cleanSummary', {
                        path: homeRelativePath(row.path),
                    })}
            </p>
            {destructive ? (
                <label className="flex flex-col gap-1">
                    <span>{t('typeName', { name: preview.name })}</span>
                    <input
                        className="rounded border border-border bg-transparent px-2 py-1 font-mono dark:border-border-dark"
                        value={typed}
                        onChange={(event) => setTyped(event.target.value)}
                        aria-label={t('typeName', { name: preview.name })}
                        data-testid="fleet-delete-checkout-name"
                    />
                </label>
            ) : null}
            {error ? (
                <p role="alert" className="text-red-600 dark:text-red-400">
                    {error}
                </p>
            ) : null}
            <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onCancel}>
                    {t('cancel')}
                </Button>
                <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void confirm()}
                    disabled={!allowed || busy}
                    data-testid="fleet-delete-checkout-confirm"
                >
                    {t(mode === 'forget' ? 'forget' : 'delete')}
                </Button>
            </div>
        </div>
    );
}
