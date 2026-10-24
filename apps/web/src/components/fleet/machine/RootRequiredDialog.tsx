'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import type { RootRequiredModel } from './machine-actions.shared';

/**
 * Machine actions (FL-09, spec §5.3, S3, U9) — "build-01 needs your password
 * for this". Ever Works never asks for it: the dialog shows the exact command
 * the computer refused to run without one, with a copy button, and how to let
 * the node's user run it without a password. There is no password field here
 * or anywhere else (README §3).
 */
export function RootRequiredDialog({
    model,
    machine,
    onClose,
}: {
    model: RootRequiredModel | null;
    machine: string;
    onClose: () => void;
}) {
    const t = useTranslations('fleet.actions.rootRequired');
    const [copied, setCopied] = useState(false);
    if (!model) return null;
    const windows = model.shell === 'powershell';

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(model.command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <div data-testid="fleet-machine-root-dialog" data-shell={model.shell}>
                    <DialogClose onClose={onClose} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {windows ? t('windowsTitle', { name: machine }) : t('title', { name: machine })}
                        </DialogTitle>
                        <DialogDescription>
                            {windows ? t('windowsBody', { name: machine }) : t('body', { name: machine })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="mt-3 flex items-center gap-2 rounded-md bg-surface-secondary dark:bg-surface-secondary-dark p-2">
                        <code className="flex-1 break-all font-mono text-sm" data-testid="fleet-machine-root-command">
                            {model.command}
                        </code>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={copy}
                            aria-label={t('copy')}
                            data-testid="fleet-machine-root-copy"
                        >
                            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                        </Button>
                    </div>
                    <p className="mt-3 text-sm text-text-muted dark:text-text-muted-dark">
                        {windows ? t('windowsHelp') : t('help')}
                    </p>
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onClose}>
                            {t('close')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
