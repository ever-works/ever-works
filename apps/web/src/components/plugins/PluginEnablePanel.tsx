'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface PluginEnablePanelProps {
    autoEnableForDirs: boolean;
    onAutoEnableChange: (checked: boolean) => void;
    onCancel: () => void;
    onConfirm: () => void;
    isPending: boolean;
}

export function PluginEnablePanel({
    autoEnableForDirs,
    onAutoEnableChange,
    onCancel,
    onConfirm,
    isPending,
}: PluginEnablePanelProps) {
    const t = useTranslations('dashboard.plugins');

    return (
        <div className="mt-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
            <label className="flex items-start gap-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={autoEnableForDirs}
                    onChange={(e) => onAutoEnableChange(e.target.checked)}
                    className="mt-0.5 rounded border-border dark:border-border-dark"
                />
                <div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('autoEnableForDirectories')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                        {t('autoEnableForDirectoriesDescription')}
                    </p>
                </div>
            </label>
            <div className="flex gap-2 mt-2">
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
            </div>
        </div>
    );
}
