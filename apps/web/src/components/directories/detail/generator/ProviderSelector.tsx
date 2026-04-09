'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils/cn';
import type { ProviderOption } from '@/lib/api/types-only';
import { resolveEffectiveDefault } from '@ever-works/plugin';
import { useTranslations } from 'next-intl';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { Tooltip } from '@/components/ui/tooltip';
import { Check, Network } from 'lucide-react';

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
        <div className="flex items-center gap-4 px-5 py-3">
            <div className="w-36 shrink-0">
                <code className="text-xs font-mono font-medium text-text-secondary dark:text-text-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark px-1.5 py-0.5 rounded">
                    {label}
                </code>
            </div>

            <div className="flex-1 flex flex-wrap gap-1.5">
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
                                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all duration-150',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                                isActive
                                    ? 'border-primary/40 bg-primary/10 text-primary shadow-sm'
                                    : 'border-border dark:border-border-dark bg-transparent text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-primary/30',
                                !provider.configured && 'opacity-40 cursor-not-allowed',
                                disabled && 'opacity-50 cursor-not-allowed',
                            )}
                        >
                            {provider.icon && (
                                <PluginIcon
                                    icon={provider.icon}
                                    name={provider.name}
                                    size={14}
                                    plain
                                />
                            )}
                            <span>
                                {provider.name}
                                {!provider.configured && ` (${t('notConfigured')})`}
                            </span>
                            {isActive && <Check className="w-3 h-3 ml-0.5" />}
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
        <div className="rounded-xl border overflow-hidden border-border dark:border-border-dark bg-surface dark:bg-surface-dark">
            <div className="px-5 py-3.5 border-b border-border dark:border-border-dark bg-surface-secondary/50 dark:bg-surface-secondary-dark/50 flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Network className="w-4 h-4 text-primary" />
                </div>
                <h4 className="text-sm font-semibold text-text dark:text-text-dark leading-tight">
                    {t('pipelineMode')}
                </h4>
            </div>

            <div className="divide-y divide-border dark:divide-border-dark">
                {pipelineProviders.map((provider) => {
                    const isActive = effectiveSelected === provider.id;
                    const row = (
                        <button
                            type="button"
                            onClick={() => onChange(provider.id)}
                            disabled={!provider.configured}
                            className={cn(
                                'w-full flex items-start gap-3 px-5 py-3 text-left transition-colors cursor-pointer',
                                isActive
                                    ? 'bg-primary/5 dark:bg-surface-secondary/6'
                                    : 'hover:bg-surface-secondary/50 dark:hover:bg-surface-secondary-dark/50',
                                !provider.configured && 'opacity-50 cursor-not-allowed',
                            )}
                        >
                            <div
                                className={cn(
                                    'mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors',
                                    isActive
                                        ? 'border-primary'
                                        : 'border-border dark:border-border-dark',
                                )}
                            >
                                {isActive && <div className="w-2 h-2 rounded-full bg-primary" />}
                            </div>
                            <div className="flex-1 min-w-0">
                                <span
                                    className={cn(
                                        'text-sm font-medium',
                                        isActive
                                            ? 'text-text dark:text-text-dark'
                                            : 'text-text-secondary dark:text-text-secondary-dark',
                                    )}
                                >
                                    {provider.name}
                                    {!provider.configured && (
                                        <span className="ml-2 text-xs font-normal text-warning">
                                            ({t('notConfigured')})
                                        </span>
                                    )}
                                </span>
                                {provider.description && (
                                    <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                                        {provider.description}
                                    </p>
                                )}
                            </div>
                        </button>
                    );

                    return !provider.configured ? (
                        <Tooltip
                            key={provider.id}
                            content={t('notConfiguredTooltip')}
                            position="bottom"
                        >
                            {row}
                        </Tooltip>
                    ) : (
                        <div key={provider.id}>{row}</div>
                    );
                })}
            </div>
        </div>
    );
}
