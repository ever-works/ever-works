'use client';

import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/** One row of the sheet: the keys to press and an already-localised label. */
export interface ShortcutRow {
    keys: readonly string[];
    label: string;
}

const RUN_SHORTCUTS = [
    { keys: ['←', '→'], label: 'window' },
    { keys: ['t'], label: 'today' },
    { keys: ['d', 'w', 'm'], label: 'views' },
    { keys: ['j', 'k'], label: 'rows' },
    { keys: ['Enter', 'o'], label: 'open' },
    { keys: ['Esc'], label: 'close' },
    { keys: ['/'], label: 'search' },
    { keys: ['?'], label: 'help' },
] as const;

/**
 * Runs ledger (AW-09) — the `?` sheet. Every shortcut listed here also has an
 * on-screen control; nothing on the page is keyboard-only.
 *
 * `extraRows` is how a HOST page extends the sheet: the Activity page owns one
 * sheet for all four of its views, so it prepends its own keys (switching
 * view) and this component keeps rendering the ledger's keys underneath.
 * Rows arrive with their labels already localised, because the host's keys
 * live in a different message namespace than the ledger's.
 */
export function RunsShortcutSheet({
    open,
    onClose,
    extraRows = [],
}: {
    open: boolean;
    onClose: () => void;
    extraRows?: readonly ShortcutRow[];
}) {
    const t = useTranslations('dashboard.runsPage.shortcuts');
    const rows: readonly ShortcutRow[] = [
        ...extraRows,
        ...RUN_SHORTCUTS.map((shortcut) => ({
            keys: shortcut.keys,
            label: t(shortcut.label),
        })),
    ];

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogTitle className="text-sm font-semibold text-text dark:text-text-dark mb-3">
                    {t('title')}
                </DialogTitle>
                <dl className="space-y-1.5 text-xs" data-testid="runs-shortcut-sheet">
                    {rows.map((row) => (
                        <div
                            key={`${row.label}:${row.keys.join('+')}`}
                            className="flex items-center justify-between gap-4"
                        >
                            <dt className="flex gap-1">
                                {row.keys.map((key) => (
                                    <kbd
                                        key={key}
                                        className="rounded border border-border dark:border-border-dark px-1.5 py-0.5 font-mono text-[11px]"
                                    >
                                        {key}
                                    </kbd>
                                ))}
                            </dt>
                            <dd className="text-text-secondary dark:text-text-secondary-dark">
                                {row.label}
                            </dd>
                        </div>
                    ))}
                </dl>
            </DialogContent>
        </Dialog>
    );
}
