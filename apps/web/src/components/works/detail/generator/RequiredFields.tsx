'use client';

import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { PluginModelSelect } from '@/components/plugins/form/PluginModelSelect';

interface CoreFormData {
    name: string;
    prompt: string;
    model?: string;
}

interface RequiredFieldsProps {
    formData: Partial<CoreFormData>;
    onChange: (updates: Partial<CoreFormData>) => void;
    modelPluginId?: string | null;
    modelDisabled?: boolean;
    modelHelperText?: string;
    children?: ReactNode;
}

export function RequiredFields({
    formData,
    onChange,
    modelPluginId,
    modelDisabled = false,
    modelHelperText,
    children,
}: RequiredFieldsProps) {
    const t = useTranslations('dashboard.workDetail.generator');

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-primary-dark/10',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <h3 className="text-lg font-medium text-text dark:text-text-dark mb-4">
                {t('requiredInfo')}
            </h3>

            <div className="space-y-4">
                <Input
                    label={t('workName')}
                    type="text"
                    value={formData.name || ''}
                    onChange={(e) => onChange({ name: e.target.value })}
                    placeholder={t('workNamePlaceholder')}
                    variant="form"
                    required
                    disabled
                />

                <Textarea
                    label={t('generationPrompt')}
                    value={formData.prompt || ''}
                    onChange={(e) => onChange({ prompt: e.target.value })}
                    placeholder={t('promptPlaceholder')}
                    rows={4}
                    variant="form"
                    required
                    helperText={t('promptHelperText')}
                />

                <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-text dark:text-text-dark">
                        {t('modelOverride')}
                    </label>
                    {modelPluginId ? (
                        <PluginModelSelect
                            pluginId={modelPluginId}
                            value={formData.model || ''}
                            onChange={(model) => onChange({ model: model || undefined })}
                            disabled={modelDisabled}
                            allowCustom={false}
                        />
                    ) : (
                        <Input
                            type="text"
                            value=""
                            placeholder={t('modelOverridePlaceholder')}
                            variant="form"
                            disabled
                        />
                    )}
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {modelHelperText || t('modelOverrideHelperText')}
                    </p>
                </div>

                {children}
            </div>
        </div>
    );
}
