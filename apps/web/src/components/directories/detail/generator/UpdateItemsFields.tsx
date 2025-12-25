'use client';

import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { GenerationMethod } from '@/lib/api/enums';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { PrUpdateInfo } from '../PrUpdateInfo';

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
    const { directory, config } = useDirectoryDetail();
    const t = useTranslations('dashboard.directoryDetail.generator');
    const tConf = useTranslations('dashboard.directoryDetail.config');

    const mainPR = directory.lastPullRequest?.main;
    const dataPR = directory.lastPullRequest?.data;
    const hasConfig = !!config && Object.keys(config).length > 0;
    const isRecreate = generationMethod === GenerationMethod.RECREATE;

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

                {isRecreate && hasConfig && (
                    <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning dark:text-warning-dark">
                        <p className="font-medium">{t('recreateInlineTitle')}</p>
                        <p className="text-xs mt-1">{t('recreateInlineDescription')}</p>
                    </div>
                )}

                <Switch
                    label={t('updateWithPullRequest')}
                    checked={updateWithPullRequest !== undefined ? updateWithPullRequest : true}
                    onChange={(checked) => onChange({ update_with_pull_request: checked })}
                    helperText={t('updateWithPullRequestDescription')}
                />
            </div>

            {/* PR Update Information */}
            <PrUpdateInfo
                mainPR={mainPR}
                dataPR={dataPR}
                className="pt-6 mt-6 border-t border-border dark:border-border-dark"
            />
        </div>
    );
}
