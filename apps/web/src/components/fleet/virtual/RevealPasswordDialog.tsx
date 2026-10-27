'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FLEET_VIRTUAL_PASSWORD_REVEAL_SEC } from '@ever-works/contracts';
import { revealFleetVirtualPasswordAction } from '@/app/actions/fleet/virtual';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * Virtual computers, phase 2 (FL-16, spec S7, §5.7, FR-21) — **Copy
 * password**: explains that the password was generated on the host and is
 * kept only there, then a single **Reveal once** fetches it (owner only;
 * audited as `node.vm.password.reveal`). It shows masked with a Show toggle
 * and a Copy button, and is wiped from the page after 60 seconds or when the
 * dialog closes — it is never kept in any store, URL or log.
 */
export function RevealPasswordDialog({
    open,
    hostNodeId,
    childNodeId,
    name,
    hostName,
    onClose,
}: {
    open: boolean;
    hostNodeId: string;
    childNodeId: string;
    name: string;
    hostName: string;
    onClose: () => void;
}) {
    const t = useTranslations('fleet.virtual.password');
    const [password, setPassword] = useState<string | null>(null);
    const [shown, setShown] = useState(false);
    const [left, setLeft] = useState(0);
    const [pending, startTransition] = useTransition();

    // Wipe the value when the dialog closes.
    useEffect(() => {
        if (!open) {
            setPassword(null);
            setShown(false);
            setLeft(0);
        }
    }, [open]);

    // Count down and wipe it at zero (FR-21: 60 seconds).
    useEffect(() => {
        if (!password) return;
        if (left <= 0) {
            setPassword(null);
            setShown(false);
            return;
        }
        const timer = setTimeout(() => setLeft((value) => value - 1), 1_000);
        return () => clearTimeout(timer);
    }, [password, left]);

    const reveal = () =>
        startTransition(async () => {
            const result = await revealFleetVirtualPasswordAction(hostNodeId, childNodeId);
            if (result.ok) {
                setPassword(result.data.password);
                setLeft(result.data.expiresInSec || FLEET_VIRTUAL_PASSWORD_REVEAL_SEC);
            } else {
                toast.error(result.error.hint || t('failed'));
            }
        });

    const copy = async () => {
        if (!password) return;
        try {
            await navigator.clipboard.writeText(password);
            toast.success(t('copied'));
        } catch {
            toast.error(t('copyFailed'));
        }
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
            <DialogContent data-testid="fleet-virtual-password-dialog">
                <DialogHeader>
                    <DialogTitle>{t('title', { name })}</DialogTitle>
                    <DialogDescription>{t('description', { host: hostName })}</DialogDescription>
                </DialogHeader>
                {password ? (
                    <div className="flex flex-col gap-2 text-sm">
                        <div className="flex items-center gap-2">
                            <code className="rounded bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-1 font-mono">
                                {shown ? password : '•'.repeat(password.length)}
                            </code>
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setShown((value) => !value)}
                            >
                                {shown ? t('hide') : t('show')}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => void copy()}
                                data-testid="fleet-virtual-password-copy"
                            >
                                {t('copy')}
                            </Button>
                        </div>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('hidesIn', { seconds: left })}
                        </p>
                    </div>
                ) : null}
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {t('close')}
                    </Button>
                    {!password ? (
                        <Button
                            type="button"
                            onClick={reveal}
                            disabled={pending}
                            data-testid="fleet-virtual-password-reveal"
                        >
                            {t('reveal')}
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
