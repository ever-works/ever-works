'use client';

import { cn } from '@/lib/utils/cn';
import type { ProviderOption } from '@/lib/api/types-only';
import { useTranslations } from 'next-intl';
import { PluginIcon } from '@/components/plugins/PluginIcon';

interface ProviderSelectorProps {
    label: string;
    providers: ProviderOption[];
    value: string | null;
    onChange: (providerId: string | null) => void;
    disabled?: boolean;
}

export function ProviderSelector({
    label,
    providers,
    value,
    onChange,
    disabled = false,
}: ProviderSelectorProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    if (providers.length === 0) {
        return null;
    }

    return (
        <div className="flex items-center gap-3 py-2">
            <div className="w-32 shrink-0">
                <span className="text-sm font-medium text-text dark:text-text-dark">{label}</span>
            </div>

            <div className="flex-1 flex flex-wrap gap-2">
                {providers.map((provider) => {
                    const isActive =
                        value === provider.id || (value === null && provider.isDefault);
                    return (
                        <button
                            type="button"
                            key={provider.id}
                            onClick={() => {
                                if (value === null && provider.isDefault) return;
                                if (value === provider.id) {
                                    onChange(null);
                                } else {
                                    onChange(provider.id);
                                }
                            }}
                            disabled={
                                disabled ||
                                !provider.configured ||
                                (value === null && provider.isDefault)
                            }
                            className={cn(
                                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors border',
                                isActive
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border dark:border-border-dark hover:border-primary/50 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                                !provider.configured && 'opacity-40 cursor-not-allowed',
                                disabled && 'opacity-50 cursor-not-allowed',
                            )}
                        >
                            {provider.icon && (
                                <PluginIcon icon={provider.icon} name={provider.name} size={20} />
                            )}
                            <span>
                                {provider.name}
                                {!provider.configured && ` (${t('notConfigured')})`}
                            </span>
                            {isActive && (
                                <svg
                                    className="w-4 h-4 text-primary"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                >
                                    <path
                                        fillRule="evenodd"
                                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                        clipRule="evenodd"
                                    />
                                </svg>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

interface PipelineModeSelectorProps {
    fullPipelineProviders: ProviderOption[];
    selectedPipeline: string | null;
    onChange: (pipelineId: string | null) => void;
}

export function PipelineModeSelector({
    fullPipelineProviders,
    selectedPipeline,
    onChange,
}: PipelineModeSelectorProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    return (
        <div
            className={cn(
                'rounded-lg border p-4',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <h4 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                {t('pipelineMode')}
            </h4>

            <div className="space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                    <input
                        type="radio"
                        name="pipeline-mode"
                        checked={!selectedPipeline}
                        onChange={() => onChange(null)}
                        className="mt-1"
                    />
                    <div className="flex-1">
                        <span className="text-sm font-medium text-text dark:text-text-dark">
                            {t('standardPipeline')}
                        </span>
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('standardPipelineDescription')}
                        </p>
                    </div>
                </label>

                {fullPipelineProviders.map((provider) => (
                    <label key={provider.id} className="flex items-start gap-3 cursor-pointer">
                        <input
                            type="radio"
                            name="pipeline-mode"
                            checked={selectedPipeline === provider.id}
                            onChange={() => onChange(provider.id)}
                            disabled={!provider.configured}
                            className="mt-1"
                        />
                        <div className="flex-1">
                            <span className="text-sm font-medium text-text dark:text-text-dark">
                                {provider.name}
                                {!provider.configured && (
                                    <span className="ml-2 text-xs text-warning">
                                        ({t('notConfigured')})
                                    </span>
                                )}
                            </span>
                            {provider.description && (
                                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                    {provider.description}
                                </p>
                            )}
                        </div>
                    </label>
                ))}
            </div>
        </div>
    );
}
