'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose,
} from '@/components/ui/dialog';

interface PluginEnablePanelProps {
    open: boolean;
    autoEnableForDirs: boolean;
    onAutoEnableChange: (checked: boolean) => void;
    onCancel: () => void;
    onConfirm: () => void;
    isPending: boolean;
}

export function PluginEnablePanel({
    open,
    autoEnableForDirs,
    onAutoEnableChange,
    onCancel,
    onConfirm,
    isPending,
}: PluginEnablePanelProps) {
    const t = useTranslations('dashboard.plugins');

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
            <DialogContent>
                <DialogClose onClose={onCancel} />
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('enable')}
                    </DialogTitle>
                    <DialogDescription>{t('enableDescription')}</DialogDescription>
                </DialogHeader>

                <label className="flex items-start gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={autoEnableForDirs}
                        onChange={(e) => onAutoEnableChange(e.target.checked)}
                        className="mt-0.5 rounded border-border dark:border-border-dark"
                    />
                    <div>
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('autoEnableForWorks')}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                            {t('autoEnableForWorksDescription')}
                        </p>
                    </div>
                </label>

                <DialogFooter>
                    <Button size="sm" variant="ghost" onClick={onCancel}>
                        {t('cancel')}
                    </Button>
                    <Button
                        size="sm"
                        variant="primary"
                        onClick={onConfirm}
                        disabled={isPending}
                        loading={isPending}
                    >
                        {t('enable')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
