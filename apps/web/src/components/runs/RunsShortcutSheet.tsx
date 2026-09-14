'use client';

import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

const SHORTCUTS = [
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
 */
export function RunsShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    const t = useTranslations('dashboard.runsPage.shortcuts');
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogTitle className="text-sm font-semibold text-text dark:text-text-dark mb-3">
                    {t('title')}
                </DialogTitle>
                <dl className="space-y-1.5 text-xs" data-testid="runs-shortcut-sheet">
                    {SHORTCUTS.map((shortcut) => (
                        <div
                            key={shortcut.label}
                            className="flex items-center justify-between gap-4"
                        >
                            <dt className="flex gap-1">
                                {shortcut.keys.map((key) => (
                                    <kbd
                                        key={key}
                                        className="rounded border border-border dark:border-border-dark px-1.5 py-0.5 font-mono text-[11px]"
                                    >
                                        {key}
                                    </kbd>
                                ))}
                            </dt>
                            <dd className="text-text-secondary dark:text-text-secondary-dark">
                                {t(shortcut.label)}
                            </dd>
                        </div>
                    ))}
                </dl>
            </DialogContent>
        </Dialog>
    );
}
