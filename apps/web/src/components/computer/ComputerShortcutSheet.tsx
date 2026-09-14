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

/** The keys a watching owner has. Take-over and teach keys arrive with those features. */
const SHORTCUTS: ReadonlyArray<{
    keys: string;
    label: 'refresh' | 'quality' | 'channel' | 'node' | 'sheet';
}> = [
    { keys: 'R', label: 'refresh' },
    { keys: 'Q', label: 'quality' },
    { keys: 'C', label: 'channel' },
    { keys: 'N', label: 'node' },
    { keys: '?', label: 'sheet' },
];

export function ComputerShortcutSheet({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations('dashboard.computer.shortcuts');
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </DialogTitle>
                </DialogHeader>
                <dl
                    data-testid="computer-shortcuts"
                    className="grid grid-cols-[4rem_1fr] gap-y-1.5 text-sm"
                >
                    {SHORTCUTS.map((shortcut) => (
                        <div key={shortcut.keys} className="contents">
                            <dt>
                                <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-xs dark:border-border-dark">
                                    {shortcut.keys}
                                </kbd>
                            </dt>
                            <dd>{t(shortcut.label)}</dd>
                        </div>
                    ))}
                </dl>
                <DialogFooter>
                    <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                        {t('close')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
