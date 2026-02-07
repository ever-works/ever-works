'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogClose,
} from '@/components/ui/dialog';

interface PluginDisableWarningProps {
    onCancel: () => void;
    onConfirm: () => void;
    isPending: boolean;
}

export function PluginDisableWarning({
    onCancel,
    onConfirm,
    isPending,
}: PluginDisableWarningProps) {
    const t = useTranslations('dashboard.plugins');

    return (
        <Dialog open onOpenChange={(open) => !open && onCancel()}>
            <DialogContent>
                <DialogClose onClose={onCancel} />
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark flex items-center gap-2">
                        <AlertTriangle className="w-5 h-5 text-warning" />
                        {t('disable')}
                    </DialogTitle>
                </DialogHeader>

                <p className="text-sm text-warning">{t('disableWarning')}</p>

                <DialogFooter>
                    <Button size="sm" variant="ghost" onClick={onCancel}>
                        {t('cancel')}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onConfirm}
                        disabled={isPending}
                        loading={isPending}
                        className="text-danger hover:text-danger hover:bg-danger/10"
                    >
                        {t('confirmDisable')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
