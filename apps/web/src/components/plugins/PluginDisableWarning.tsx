'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
        <div className="mt-3 p-3 rounded-lg bg-warning/10 border border-warning/30">
            <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <div className="flex-1">
                    <p className="text-sm text-warning">{t('disableWarning')}</p>
                    <div className="flex gap-2 mt-2">
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
                    </div>
                </div>
            </div>
        </div>
    );
}
