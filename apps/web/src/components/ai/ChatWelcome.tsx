'use client';

import { useTranslations } from 'next-intl';
import { Sparkles, FolderSearch, Globe, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface ChatWelcomeProps {
    onSuggestion: (text: string) => void;
}

const suggestions = [
    'Create a directory of AI tools',
    'List top SaaS products in 2026',
    'Build a developer resources hub',
    'Compare project management tools',
];

type CapabilityKey = 'directoryCreation' | 'webResearch' | 'contentGeneration' | 'smartSuggestions';
type CapabilityDescKey =
    | 'directoryCreationDesc'
    | 'webResearchDesc'
    | 'contentGenerationDesc'
    | 'smartSuggestionsDesc';

const capabilities: Array<{
    icon: typeof FolderSearch;
    title: CapabilityKey;
    description: CapabilityDescKey;
}> = [
    {
        icon: FolderSearch,
        title: 'directoryCreation',
        description: 'directoryCreationDesc',
    },
    {
        icon: Globe,
        title: 'webResearch',
        description: 'webResearchDesc',
    },
    {
        icon: Sparkles,
        title: 'contentGeneration',
        description: 'contentGenerationDesc',
    },
    {
        icon: Lightbulb,
        title: 'smartSuggestions',
        description: 'smartSuggestionsDesc',
    },
];

export function ChatWelcome({ onSuggestion }: ChatWelcomeProps) {
    const t = useTranslations('dashboard.aiChat');
    const tc = useTranslations('dashboard.aiChat.capabilities');

    return (
        <div className="flex flex-col h-full px-5 py-6 overflow-y-auto">
            {/* Welcome heading */}
            <div className="mb-6">
                <h2 className="text-lg font-semibold text-text dark:text-white tracking-tight">
                    {t('welcomeTitle')}
                </h2>
                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                    {t('welcomeSubtitle')}
                </p>
            </div>

            {/* Suggestion chips */}
            <div className="flex flex-wrap gap-1.5 mb-6">
                {suggestions.map((text) => (
                    <button
                        key={text}
                        type="button"
                        onClick={() => onSuggestion(text)}
                        className={cn(
                            'inline-flex items-center px-2.5 py-1.5 rounded-lg text-[11px] font-medium',
                            'border border-border dark:border-white/8',
                            'bg-surface-secondary/60 dark:bg-white/[0.04]',
                            'text-text-secondary dark:text-text-secondary-dark',
                            'hover:bg-surface-tertiary/60 dark:hover:bg-white/[0.08]',
                            'hover:text-text dark:hover:text-white',
                            'hover:border-primary/20 dark:hover:border-white/15',
                            'transition-all duration-150 cursor-pointer',
                        )}
                    >
                        {text}
                    </button>
                ))}
            </div>

            {/* Capability cards grid */}
            <div className="grid grid-cols-2 gap-2.5 mt-auto">
                {capabilities.map((cap) => (
                    <div
                        key={cap.title}
                        className={cn(
                            'flex flex-col gap-2 p-3 rounded-xl',
                            'border border-border dark:border-white/6',
                            'bg-surface-secondary/40 dark:bg-white/[0.025]',
                        )}
                    >
                        <div
                            className={cn(
                                'flex items-center justify-center w-7 h-7 rounded-lg',
                                'bg-primary/10 dark:bg-primary/15',
                                'text-primary dark:text-primary-400',
                            )}
                        >
                            <cap.icon className="w-3.5 h-3.5" />
                        </div>
                        <div>
                            <p className="text-[11px] font-semibold text-text dark:text-white/90 leading-tight">
                                {tc(cap.title)}
                            </p>
                            <p className="mt-0.5 text-[10px] text-text-muted dark:text-text-muted-dark leading-snug">
                                {tc(cap.description)}
                            </p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
