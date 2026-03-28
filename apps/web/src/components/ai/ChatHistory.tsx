'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { useChatContext } from './ChatProvider';
import { MessageSquare, Trash2, ArrowLeft, Loader2 } from 'lucide-react';

interface ChatHistoryProps {
    onClose: () => void;
}

export function ChatHistory({ onClose }: ChatHistoryProps) {
    const t = useTranslations('dashboard.aiChat');
    const {
        conversations,
        conversationsLoading,
        conversationId,
        loadConversation,
        deleteConv,
        refreshConversations,
    } = useChatContext();

    const [deletingId, setDeletingId] = useState<string | null>(null);

    useEffect(() => {
        refreshConversations();
    }, [refreshConversations]);

    const handleSelect = async (id: string) => {
        await loadConversation(id);
        onClose();
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setDeletingId(id);
        await deleteConv(id);
        setDeletingId(null);
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return t('historyToday');
        if (diffDays === 1) return t('historyYesterday');
        if (diffDays < 7) return t('historyDaysAgo', { days: diffDays });
        return date.toLocaleDateString();
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border dark:border-white/6 shrink-0">
                <button
                    onClick={onClose}
                    className={cn(
                        'flex items-center justify-center w-7 h-7 rounded-md',
                        'text-text-muted dark:text-text-muted-dark',
                        'hover:text-text dark:hover:text-white',
                        'hover:bg-surface-secondary dark:hover:bg-white/5',
                        'transition-colors cursor-pointer',
                    )}
                >
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <span className="text-sm font-medium text-text dark:text-white">
                    {t('history')}
                </span>
            </div>

            {/* Conversation list */}
            <div className="flex-1 overflow-y-auto">
                {conversationsLoading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-4 h-4 animate-spin text-text-muted dark:text-text-muted-dark" />
                    </div>
                ) : conversations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                        <MessageSquare className="w-8 h-8 text-text-muted/30 dark:text-text-muted-dark/30 mb-3" />
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('historyEmpty')}
                        </p>
                    </div>
                ) : (
                    <div className="p-2 space-y-0.5">
                        {conversations.map((conv) => {
                            const isActive = conversationId === conv.id;
                            const isDeleting = deletingId === conv.id;

                            return (
                                <div
                                    key={conv.id}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => !isDeleting && handleSelect(conv.id)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !isDeleting) handleSelect(conv.id);
                                    }}
                                    className={cn(
                                        'flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-left group',
                                        'transition-colors duration-75 cursor-pointer',
                                        isActive
                                            ? 'bg-primary/8 dark:bg-primary/12'
                                            : 'hover:bg-surface-secondary dark:hover:bg-white/[0.04]',
                                        isDeleting && 'opacity-50 pointer-events-none',
                                    )}
                                >
                                    <div className="flex-1 min-w-0">
                                        <p
                                            className={cn(
                                                'text-xs font-medium truncate',
                                                isActive
                                                    ? 'text-text dark:text-white'
                                                    : 'text-text-secondary dark:text-text-secondary-dark',
                                            )}
                                        >
                                            {conv.title || t('historyUntitled')}
                                        </p>
                                        <p className="text-[10px] text-text-muted dark:text-text-muted-dark mt-0.5">
                                            {formatDate(conv.updatedAt)}
                                        </p>
                                    </div>

                                    {!isDeleting ? (
                                        <button
                                            type="button"
                                            onClick={(e) => handleDelete(e, conv.id)}
                                            className={cn(
                                                'shrink-0 opacity-0 group-hover:opacity-100',
                                                'flex items-center justify-center w-6 h-6 rounded-md',
                                                'text-text-muted dark:text-text-muted-dark',
                                                'hover:text-danger hover:bg-danger/10',
                                                'transition-all cursor-pointer',
                                            )}
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    ) : (
                                        <Loader2 className="w-3 h-3 animate-spin text-text-muted shrink-0" />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
