'use client';

import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface CoreFormData {
    name: string;
    prompt: string;
    model?: string;
}

interface RequiredFieldsProps {
    formData: Partial<CoreFormData>;
    onChange: (updates: Partial<CoreFormData>) => void;
    children?: ReactNode;
}

export function RequiredFields({ formData, onChange, children }: RequiredFieldsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

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
                    label={t('directoryName')}
                    type="text"
                    value={formData.name || ''}
                    onChange={(e) => onChange({ name: e.target.value })}
                    placeholder={t('directoryNamePlaceholder')}
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

                <Input
                    label={t('modelOverride')}
                    type="text"
                    value={formData.model || ''}
                    onChange={(e) => onChange({ model: e.target.value })}
                    placeholder={t('modelOverridePlaceholder')}
                    variant="form"
                    helperText={t('modelOverrideHelperText')}
                />

                {children}
            </div>
        </div>
    );
}
