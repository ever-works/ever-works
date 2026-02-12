'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils/cn';
import type { ProviderOption } from '@/lib/api/types-only';
import { resolveEffectiveDefault } from '@ever-works/plugin';
import { useTranslations } from 'next-intl';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { Tooltip } from '@/components/ui/tooltip';

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

    const effectiveDefaultId = useMemo(() => {
        if (value !== null) return null;
        return resolveEffectiveDefault(providers)?.id ?? null;
    }, [value, providers]);

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
                    const isActive = value === provider.id || provider.id === effectiveDefaultId;
                    const button = (
                        <button
                            type="button"
                            onClick={() => {
                                if (provider.id === effectiveDefaultId) return;
                                if (value === provider.id) {
                                    onChange(null);
                                } else {
                                    onChange(provider.id);
                                }
                            }}
                            disabled={
                                disabled ||
                                !provider.configured ||
                                provider.id === effectiveDefaultId
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

                    return !provider.configured ? (
                        <Tooltip key={provider.id} content={t('notConfiguredTooltip')}>
                            {button}
                        </Tooltip>
                    ) : (
                        <span key={provider.id}>{button}</span>
                    );
                })}
            </div>
        </div>
    );
}

interface PipelineModeSelectorProps {
    pipelineProviders: ProviderOption[];
    selectedPipeline: string | null;
    onChange: (pipelineId: string | null) => void;
}

export function PipelineModeSelector({
    pipelineProviders,
    selectedPipeline,
    onChange,
}: PipelineModeSelectorProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    // When selectedPipeline is null, the default pipeline is active
    const effectiveSelected =
        selectedPipeline ?? pipelineProviders.find((p) => p.isDefault)?.id ?? null;

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
                {pipelineProviders.map((provider) => {
                    const isActive = effectiveSelected === provider.id;
                    const radioLabel = (
                        <label className="flex items-start gap-3 cursor-pointer">
                            <input
                                type="radio"
                                name="pipeline-mode"
                                checked={isActive}
                                onChange={() => onChange(provider.isDefault ? null : provider.id)}
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
                    );

                    return !provider.configured ? (
                        <Tooltip
                            key={provider.id}
                            content={t('notConfiguredTooltip')}
                            position="bottom"
                        >
                            {radioLabel}
                        </Tooltip>
                    ) : (
                        <div key={provider.id}>{radioLabel}</div>
                    );
                })}
            </div>
        </div>
    );
}
