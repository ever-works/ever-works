'use client';

import { cn } from '@/lib/utils/cn';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { Tooltip } from '@/components/ui/tooltip';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import type { ProviderOption } from '@/lib/api/types-only';

interface ChatProviderSelectorProps {
    providers: ProviderOption[];
    selectedProvider: string | null;
    isStreaming: boolean;
    onSelect: (id: string) => void;
}

export function ChatProviderSelector({
    providers,
    selectedProvider,
    isStreaming,
    onSelect,
}: ChatProviderSelectorProps) {
    const t = useTranslations('dashboard.aiChat');

    if (providers.length <= 1) return null;

    return (
        <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {providers.map((provider) => {
                const isActive = selectedProvider === provider.id;
                const isDisabled = !provider.configured || isStreaming;

                const button = (
                    <button
                        key={provider.id}
                        type="button"
                        onClick={() => onSelect(provider.id)}
                        disabled={isDisabled}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border transition-all duration-150 shrink-0',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                            isActive
                                ? 'border-primary/40 bg-primary/10 text-primary shadow-sm'
                                : 'border-border dark:border-border-dark bg-transparent text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-primary/30',
                            !provider.configured && 'opacity-40 cursor-not-allowed',
                            isStreaming && provider.configured && 'opacity-50 cursor-not-allowed',
                        )}
                    >
                        {provider.icon && (
                            <PluginIcon icon={provider.icon} name={provider.name} size={14} plain />
                        )}
                        <span>{provider.name}</span>
                        {isActive && <Check className="w-3 h-3 ml-0.5" />}
                    </button>
                );

                return !provider.configured ? (
                    <Tooltip key={provider.id} content={t('providerNotConfigured')}>
                        {button}
                    </Tooltip>
                ) : (
                    <span key={provider.id}>{button}</span>
                );
            })}
        </div>
    );
}
