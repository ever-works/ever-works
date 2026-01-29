'use client';

import { cn } from '@/lib/utils/cn';
import type { ProviderOption, PluginIcon } from '@/lib/api/types-only';
import { useTranslations } from 'next-intl';

interface ProviderSelectorProps {
    /** Category label (e.g., "Search Provider") */
    label: string;
    /** Description text */
    description?: string;
    /** Available providers for this category */
    providers: ProviderOption[];
    /** Currently selected provider ID (null = use default) */
    value: string | null;
    /** Callback when selection changes */
    onChange: (providerId: string | null) => void;
    /** Whether this selector is disabled */
    disabled?: boolean;
    /** Show "Use Default" option */
    showUseDefault?: boolean;
}

/**
 * Renders a provider selection dropdown for a specific capability category.
 * Used in the Generator Form to allow users to override default providers.
 */
export function ProviderSelector({
    label,
    description,
    providers,
    value,
    onChange,
    disabled = false,
    showUseDefault = true,
}: ProviderSelectorProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    if (providers.length === 0) {
        return null;
    }

    const selectedProvider = providers.find((p) => p.id === value);
    const defaultProvider = providers.find((p) => p.isDefault);

    return (
        <div className="space-y-2">
            <label className="block text-sm font-medium text-text dark:text-text-dark">
                {label}
            </label>
            {description && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{description}</p>
            )}
            <div className="relative">
                <select
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value || null)}
                    disabled={disabled}
                    className={cn(
                        'w-full px-3 py-2 rounded-lg border text-sm appearance-none',
                        'bg-surface dark:bg-surface-dark',
                        'border-border dark:border-border-dark',
                        'text-text dark:text-text-dark',
                        disabled && 'opacity-50 cursor-not-allowed',
                    )}
                >
                    {showUseDefault && (
                        <option value="">
                            {t('useDirectoryDefault')}
                            {defaultProvider && ` (${defaultProvider.name})`}
                        </option>
                    )}
                    {providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                            {provider.name}
                            {provider.isDefault && ` (${t('default')})`}
                            {!provider.configured && ` - ${t('notConfigured')}`}
                        </option>
                    ))}
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                    <svg
                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 9l-7 7-7-7"
                        />
                    </svg>
                </div>
            </div>
            {selectedProvider?.description && (
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {selectedProvider.description}
                </p>
            )}
        </div>
    );
}

/**
 * Renders a provider icon.
 */
export function ProviderIcon({ icon, className }: { icon?: PluginIcon; className?: string }) {
    if (!icon) return null;

    const baseClass = cn('w-4 h-4', className);

    switch (icon.type) {
        case 'emoji':
            return <span className={baseClass}>{icon.value}</span>;
        case 'lucide':
            // For now, just render the icon name as text - could be enhanced with actual Lucide icons
            return <span className={baseClass}>{icon.value}</span>;
        case 'svg':
            return (
                <span
                    className={baseClass}
                    dangerouslySetInnerHTML={{ __html: icon.value }}
                    style={{ color: icon.color }}
                />
            );
        case 'url':
        case 'base64':
            return (
                <img
                    src={
                        icon.type === 'base64' ? `data:image/png;base64,${icon.value}` : icon.value
                    }
                    alt=""
                    className={baseClass}
                    style={{ backgroundColor: icon.backgroundColor }}
                />
            );
        default:
            return null;
    }
}

interface PipelineModeSelectorProps {
    /** Available full pipeline providers */
    fullPipelineProviders: ProviderOption[];
    /** Current pipeline selection (null = standard pipeline) */
    selectedPipeline: string | null;
    /** Callback when pipeline mode changes */
    onChange: (pipelineId: string | null) => void;
}

/**
 * Renders the pipeline mode selector - allows choosing between
 * Standard Pipeline (step-by-step) or a Full Pipeline provider.
 */
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
                {/* Standard Pipeline Option */}
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

                {/* Full Pipeline Options */}
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
