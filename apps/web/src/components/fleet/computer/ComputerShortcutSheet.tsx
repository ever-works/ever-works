'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { SHORTCUT_PRIORITY } from '@/lib/keyboard/shortcut-registry';
import { useShortcut } from '@/lib/hooks/use-shortcut';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * The keys a computer page answers to (spec §5.12), in the order the sheet
 * lists them. A key written as a word (Home, End) is an i18n key under
 * `kbd.`; a symbol is shown as it is.
 */
export const FLEET_COMPUTER_SHORTCUTS = [
    { keys: ['F'], label: 'favourite' },
    { keys: ['←', '→'], label: 'tabs' },
    { keys: ['kbd.home', 'kbd.end'], label: 'firstLastTab' },
    { keys: ['?'], label: 'sheet' },
] as const;

/**
 * Fleet hub (FL-01, FR-34, spec §5.12, T-28) — the computer page's shortcut
 * sheet, opened with `?` (never while typing). It takes the key over from the
 * dashboard's own help for as long as a computer page is open, through the
 * shared shortcut registry, so one keystroke opens one sheet.
 */
export function ComputerShortcutSheet() {
    const t = useTranslations('fleet.computer.shortcuts');
    const [open, setOpen] = useState(false);

    useShortcut(
        {
            id: 'fleet.computer.shortcuts',
            scope: 'fleet-computer',
            priority: SHORTCUT_PRIORITY.screen,
        },
        (event) => event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey,
        () => setOpen(true),
    );

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
                <div data-testid="fleet-computer-shortcuts">
                    <DialogClose onClose={() => setOpen(false)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </DialogTitle>
                        <DialogDescription>{t('description')}</DialogDescription>
                    </DialogHeader>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                        {FLEET_COMPUTER_SHORTCUTS.map((shortcut) => (
                            <div key={shortcut.label} className="contents">
                                <dt className="flex items-center gap-1">
                                    {shortcut.keys.map((key) => (
                                        <kbd
                                            key={key}
                                            className="min-w-6 rounded border border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark px-1.5 py-0.5 text-center font-mono text-xs"
                                        >
                                            {key === 'kbd.home'
                                                ? t('kbd.home')
                                                : key === 'kbd.end'
                                                  ? t('kbd.end')
                                                  : key}
                                        </kbd>
                                    ))}
                                </dt>
                                <dd className="text-text dark:text-text-dark">
                                    {t(`keys.${shortcut.label}`)}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            </DialogContent>
        </Dialog>
    );
}
