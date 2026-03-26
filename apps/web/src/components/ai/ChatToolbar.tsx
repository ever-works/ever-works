'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Plus, History } from 'lucide-react';
import { ChatProviderSelector } from './ChatProviderSelector';
import type { ProviderOption } from '@/lib/api/types-only';

interface ChatToolbarProps {
    isStreaming: boolean;
    providers: ProviderOption[];
    selectedProvider: string;
    onSelectProvider: (id: string) => void;
    onNewChat: () => void;
    onOpenHistory: () => void;
}

const toolbarButtonClass = cn(
    'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium',
    'text-text-secondary dark:text-text-secondary-dark',
    'hover:bg-surface-secondary dark:hover:bg-white/5 hover:text-text dark:hover:text-white',
    'disabled:opacity-40 disabled:cursor-not-allowed',
    'transition-colors cursor-pointer',
);

export function ChatToolbar({
    isStreaming,
    providers,
    selectedProvider,
    onSelectProvider,
    onNewChat,
    onOpenHistory,
}: ChatToolbarProps) {
    const t = useTranslations('dashboard.aiChat');

    return (
        <div className="flex items-center justify-between px-4 h-16 shrink-0">
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={onNewChat}
                    disabled={isStreaming}
                    className={toolbarButtonClass}
                >
                    <Plus className="w-3 h-3" />
                    {t('newChat')}
                </button>
                <button type="button" onClick={onOpenHistory} className={toolbarButtonClass}>
                    <History className="w-3 h-3" />
                    {t('history')}
                </button>
            </div>

            <ChatProviderSelector
                providers={providers}
                selectedProvider={selectedProvider}
                isStreaming={isStreaming}
                onSelect={onSelectProvider}
            />
        </div>
    );
}
