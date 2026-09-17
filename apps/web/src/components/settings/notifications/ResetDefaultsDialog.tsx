'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

interface ResetDefaultsDialogProps {
    open: boolean;
    changing: number;
    total: number;
    pending: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

/**
 * AW-13 — "Reset to recommended?" States how many rows will change before
 * anything is written, and what a reset leaves alone.
 */
export function ResetDefaultsDialog({
    open,
    changing,
    total,
    pending,
    onCancel,
    onConfirm,
}: ResetDefaultsDialogProps) {
    const t = useTranslations('notifications-v2.preferences');
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('reset.dialogTitle')}</DialogTitle>
                    <DialogDescription>
                        {t('reset.dialogBody', { count: changing, total })}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="secondary" onClick={onCancel} disabled={pending}>
                        {t('reset.cancel')}
                    </Button>
                    <Button variant="primary" onClick={onConfirm} disabled={pending}>
                        {t('reset.confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
