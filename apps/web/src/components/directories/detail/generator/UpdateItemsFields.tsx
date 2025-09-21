'use client';

import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { GenerationMethod } from '@/lib/api/enums';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface UpdateItemsFieldsProps {
    generationMethod?: GenerationMethod;
    updateWithPullRequest?: boolean;
    onChange: (updates: {
        generation_method?: GenerationMethod;
        update_with_pull_request?: boolean;
    }) => void;
}

export function UpdateItemsFields({
    generationMethod,
    updateWithPullRequest,
    onChange,
}: UpdateItemsFieldsProps) {
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
                {t('updateConfiguration')}
            </h3>

            <div className="space-y-4">
                <Select
                    label={t('generationMethod')}
                    value={generationMethod || GenerationMethod.CREATE_UPDATE}
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
                    checked={updateWithPullRequest !== undefined ? updateWithPullRequest : true}
                    onChange={(checked) => onChange({ update_with_pull_request: checked })}
                    helperText={t('updateWithPullRequestDescription')}
                />
            </div>
        </div>
    );
}
