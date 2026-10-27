'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/** The session page's keys (spec §4.10): letters act while the terminal does not have the keyboard. */
export const SESSION_SHORTCUTS = [
    { keys: ['T'], label: 'takeKeyboard' },
    { keys: ['W'], label: 'watchOnly' },
    { keys: ['R'], label: 'rename' },
    { keys: ['E'], label: 'end' },
    { keys: ['N'], label: 'newSession' },
    { keys: ['?'], label: 'help' },
    { keys: ['Esc', 'Esc'], label: 'release' },
] as const;

/**
 * Sessions on computers (FL-04 P1b) — the `?` sheet of the session page. The
 * letters act only while focus is outside the terminal; while you drive,
 * Esc Esc is the one key the page keeps (it leaves the terminal), so every
 * other key reaches the session.
 */
export function SessionShortcutSheet({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations('fleet.sessions.shortcuts');
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </DialogTitle>
                </DialogHeader>
                <dl className="space-y-2 text-sm" data-testid="fleet-session-shortcut-sheet">
                    {SESSION_SHORTCUTS.map((shortcut) => (
                        <div
                            key={shortcut.label}
                            className="flex items-center justify-between gap-4"
                        >
                            <dt className="text-text dark:text-text-dark">{t(shortcut.label)}</dt>
                            <dd className="flex gap-1">
                                {shortcut.keys.map((key, index) => (
                                    <kbd
                                        key={`${key}-${index}`}
                                        className="rounded border border-border dark:border-border-dark px-1.5 py-0.5 font-mono text-xs"
                                    >
                                        {key}
                                    </kbd>
                                ))}
                            </dd>
                        </div>
                    ))}
                </dl>
                <DialogFooter>
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>
                        {t('close')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
