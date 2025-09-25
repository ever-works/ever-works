'use client';

import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { GenerationMethod } from '@/lib/api/enums';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { Link } from '@/i18n/navigation';

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
    const { directory } = useDirectoryDetail();
    const t = useTranslations('dashboard.directoryDetail.generator');
    const tConf = useTranslations('dashboard.directoryDetail.config');

    const mainPR = directory.lastPullRequest?.main;
    const dataPR = directory.lastPullRequest?.data;

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

            {/* PR Update Information */}
            {(mainPR || dataPR) && (
                <div className="mt-6 border-t border-border dark:border-border-dark">
                    <h4 className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-2 mt-5">
                        {tConf('pullRequestUpdate')}
                    </h4>

                    <div className="bg-surface dark:bg-surface-dark rounded-md p-3 space-y-2">
                        <div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {tConf('mainRepository')}
                            </p>
                            <Link
                                href={mainPR?.url || '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm text-primary hover:underline font-mono"
                            >
                                {mainPR?.branch.substring(0, 10)} -{' '}
                                {mainPR?.number ? `#${mainPR.number}` : '-'}
                            </Link>
                        </div>

                        <div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {tConf('dataRepository')}
                            </p>
                            <Link
                                href={dataPR?.url || '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm text-primary hover:underline font-mono"
                            >
                                {mainPR?.branch.substring(0, 10)} -{' '}
                                {dataPR?.number ? `#${dataPR.number}` : '-'}
                            </Link>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
