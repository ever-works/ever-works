'use client';

import type { PluginIcon as PluginIconType } from '@/lib/api/types-only';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { cn } from '@/lib/utils/cn';
import { Check } from 'lucide-react';

interface ProviderChoiceButtonProps {
    name: string;
    icon?: PluginIconType;
    isActive: boolean;
    disabled?: boolean;
    notConfigured?: boolean;
    notConfiguredLabel?: string;
    nameClassName?: string;
    onSelect: () => void;
}

export function ProviderChoiceButton({
    name,
    icon,
    isActive,
    disabled = false,
    notConfigured = false,
    notConfiguredLabel,
    nameClassName,
    onSelect,
}: ProviderChoiceButtonProps) {
    return (
        <button
            type="button"
            aria-pressed={isActive}
            onClick={onSelect}
            disabled={disabled || notConfigured}
            className={cn(
                'inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-all duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                isActive
                    ? 'border-primary/40 bg-primary/10 text-primary shadow-sm'
                    : 'border-border dark:border-border-dark bg-transparent text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-primary/30',
                notConfigured && 'opacity-40 cursor-not-allowed',
                disabled && 'opacity-50 cursor-not-allowed',
            )}
        >
            {icon && <PluginIcon icon={icon} name={name} size={14} plain />}
            <span className="min-w-0 text-left">
                <span className="flex items-center gap-1.5">
                    <span className={cn(nameClassName)}>
                        {name}
                        {notConfigured && notConfiguredLabel ? ` (${notConfiguredLabel})` : ''}
                    </span>
                    {isActive && <Check className="w-3 h-3" />}
                </span>
            </span>
        </button>
    );
}
