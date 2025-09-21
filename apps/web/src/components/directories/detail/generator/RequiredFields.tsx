'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CreateItemsGeneratorDto } from '@/lib/api/types-only';
import { GenerationMethod } from '@/lib/api/enums';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface RequiredFieldsProps {
    formData: Partial<CreateItemsGeneratorDto>;
    onChange: (updates: Partial<CreateItemsGeneratorDto>) => void;
}

export function RequiredFields({ formData, onChange }: RequiredFieldsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
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

                <Textarea
                    label={t('repositoryDescription')}
                    value={formData.repository_description || ''}
                    onChange={(e) => onChange({ repository_description: e.target.value })}
                    placeholder={t('repositoryPlaceholder')}
                    rows={2}
                    variant="form"
                />

                <Select
                    label={t('generationMethod')}
                    value={formData.generation_method || GenerationMethod.CREATE_UPDATE}
                    onChange={(e) =>
                        onChange({ generation_method: e.target.value as GenerationMethod })
                    }
                    variant="form"
                >
                    <option value={GenerationMethod.CREATE_UPDATE}>
                        {t('methodCreateUpdate')}
                    </option>
                    <option value={GenerationMethod.RECREATE}>{t('methodRecreate')}</option>
                </Select>

                <Switch
                    label={t('updateWithPullRequest')}
                    checked={
                        formData.update_with_pull_request !== undefined
                            ? formData.update_with_pull_request
                            : true
                    }
                    onChange={(checked) => onChange({ update_with_pull_request: checked })}
                    helperText={t('updateWithPullRequestDescription')}
                />
            </div>
        </div>
    );
}
