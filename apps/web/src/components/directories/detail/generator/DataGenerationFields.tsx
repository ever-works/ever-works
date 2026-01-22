'use client';

import { Switch } from '@/components/ui/switch';
import { DataVolumeMode } from '@/lib/api/enums';
import { ConfigDto } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface DataGenerationFieldsProps {
    config?: ConfigDto;
    onChange: (updates: Partial<{ config?: ConfigDto }>) => void;
}

export function DataGenerationFields({ config, onChange }: DataGenerationFieldsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    const dataVolumeMode = config?.data_volume_mode || DataVolumeMode.REAL;
    const generateCategories = config?.generate_categories ?? true;
    const generateTags = config?.generate_tags ?? true;
    const generateBrands = config?.generate_brands ?? true;

    const handleModeChange = (mode: DataVolumeMode) => {
        onChange({
            config: {
                ...config,
                data_volume_mode: mode,
            },
        });
    };

    const handleToggleChange = (
        field: 'generate_categories' | 'generate_tags' | 'generate_brands',
        checked: boolean,
    ) => {
        onChange({
            config: {
                ...config,
                [field]: checked,
            },
        });
    };

    return (
        <div className="space-y-6">
            {/* Data Volume Mode Selector */}
            <div>
                <label className="block text-sm font-medium text-text dark:text-text-dark mb-1">
                    {t('dataVolumeMode')}
                </label>
                <div className="grid grid-cols-2 gap-3 mt-2">
                    <button
                        type="button"
                        onClick={() => handleModeChange(DataVolumeMode.REAL)}
                        className={cn(
                            'relative flex flex-col items-start p-4 rounded-lg border transition-all',
                            dataVolumeMode === DataVolumeMode.REAL
                                ? 'border-primary dark:border-primary-dark bg-primary/5 dark:bg-primary-dark/5'
                                : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark hover:border-primary/50 dark:hover:border-primary-dark/50',
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <div
                                className={cn(
                                    'w-4 h-4 rounded-full border-2 flex items-center justify-center',
                                    dataVolumeMode === DataVolumeMode.REAL
                                        ? 'border-primary dark:border-primary-dark'
                                        : 'border-border dark:border-border-dark',
                                )}
                            >
                                {dataVolumeMode === DataVolumeMode.REAL && (
                                    <div className="w-2 h-2 rounded-full bg-primary dark:bg-primary-dark" />
                                )}
                            </div>
                            <span className="text-sm font-medium text-text dark:text-text-dark">
                                {t('dataVolumeModeReal')}
                            </span>
                        </div>
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-2 text-left">
                            {t('dataVolumeModeRealDescription')}
                        </p>
                    </button>

                    <button
                        type="button"
                        onClick={() => handleModeChange(DataVolumeMode.SAMPLE)}
                        className={cn(
                            'relative flex flex-col items-start p-4 rounded-lg border transition-all',
                            dataVolumeMode === DataVolumeMode.SAMPLE
                                ? 'border-primary dark:border-primary-dark bg-primary/5 dark:bg-primary-dark/5'
                                : 'border-border dark:border-border-dark bg-surface dark:bg-surface-dark hover:border-primary/50 dark:hover:border-primary-dark/50',
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <div
                                className={cn(
                                    'w-4 h-4 rounded-full border-2 flex items-center justify-center',
                                    dataVolumeMode === DataVolumeMode.SAMPLE
                                        ? 'border-primary dark:border-primary-dark'
                                        : 'border-border dark:border-border-dark',
                                )}
                            >
                                {dataVolumeMode === DataVolumeMode.SAMPLE && (
                                    <div className="w-2 h-2 rounded-full bg-primary dark:bg-primary-dark" />
                                )}
                            </div>
                            <span className="text-sm font-medium text-text dark:text-text-dark">
                                {t('dataVolumeModeSample')}
                            </span>
                        </div>
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-2 text-left">
                            {t('dataVolumeModeSampleDescription')}
                        </p>
                    </button>
                </div>
            </div>

            {/* Entity Generation Toggles */}
            <div>
                <label className="block text-sm font-medium text-text dark:text-text-dark mb-3">
                    {t('entityGeneration')}
                </label>
                <div className="space-y-3">
                    <Switch
                        label={t('generateCategories')}
                        checked={generateCategories}
                        onChange={(checked) => handleToggleChange('generate_categories', checked)}
                        helperText={t('generateCategoriesDescription')}
                    />

                    <Switch
                        label={t('generateTags')}
                        checked={generateTags}
                        onChange={(checked) => handleToggleChange('generate_tags', checked)}
                        helperText={t('generateTagsDescription')}
                    />

                    <Switch
                        label={t('generateBrands')}
                        checked={generateBrands}
                        onChange={(checked) => handleToggleChange('generate_brands', checked)}
                        helperText={t('generateBrandsDescription')}
                    />
                </div>
            </div>
        </div>
    );
}
