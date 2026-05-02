'use client';

import type { ProviderOption } from '@/lib/api/types-only';
import { ProviderSelector } from '../generator/ProviderSelector';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useTranslations } from 'next-intl';

interface ScreenshotProviderDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    providers: ProviderOption[];
    selectedProvider: string | null;
    onSelectedProviderChange: (providerId: string | null) => void;
    onConfirm: () => void;
    isSubmitting: boolean;
}

export function ScreenshotProviderDialog({
    open,
    onOpenChange,
    providers,
    selectedProvider,
    onSelectedProviderChange,
    onConfirm,
    isSubmitting,
}: ScreenshotProviderDialogProps) {
    const t = useTranslations('dashboard.workDetail.items');

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{t('screenshot.selectProviderTitle')}</DialogTitle>
                    <DialogDescription>
                        {t('screenshot.selectProviderDescription')}
                    </DialogDescription>
                </DialogHeader>

                <div className="py-2">
                    <ProviderSelector
                        label={t('screenshot.providerLabel')}
                        providers={providers}
                        value={selectedProvider}
                        onChange={onSelectedProviderChange}
                        disabled={isSubmitting}
                    />
                </div>

                <DialogFooter>
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        disabled={isSubmitting}
                    >
                        {t('addModal.cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={onConfirm}
                        loading={isSubmitting}
                        disabled={isSubmitting || !selectedProvider}
                    >
                        {t('screenshot.confirmCapture')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
