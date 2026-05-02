'use client';

import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { GenerationMethod } from '@/lib/api/enums';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useWorkDetail } from '../WorkDetailContext';
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
    const { work, config } = useWorkDetail();
    const t = useTranslations('dashboard.workDetail.generator');
    const tConf = useTranslations('dashboard.workDetail.config');

    const mainPR = work.lastPullRequest?.main;
    const dataPR = work.lastPullRequest?.data;
    const hasConfig = !!config && Object.keys(config).length > 0;
    const isRecreate = generationMethod === GenerationMethod.RECREATE;

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-primary-dark/10',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <h3 className="text-lg font-medium text-text dark:text-text-dark mb-4">
                {t('updateConfiguration')}
            </h3>

            <div className="space-y-4">
                <div>
                    <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                        {t('generationMethod')}
                    </label>
                    <Select
                        value={generationMethod || GenerationMethod.CREATE_UPDATE}
                        onValueChange={(val) =>
                            onChange({ generation_method: val as GenerationMethod })
                        }
                    >
                        <option value={GenerationMethod.CREATE_UPDATE}>
                            {t('methodCreateUpdate')}
                        </option>
                        <option value={GenerationMethod.RECREATE}>{t('methodRecreate')}</option>
                    </Select>
                </div>

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
