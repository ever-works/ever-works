'use client';

import { cn } from '@/lib/utils/cn';
import { ChatInterface } from './ChatInterface';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const borderToggleClass = cn(
    'absolute -right-3 top-1/2 -translate-y-1/2 z-10',
    'flex items-center justify-center w-6 h-6 rounded-full',
    'bg-white dark:bg-surface-dark',
    'border border-border dark:border-white/10',
    'text-text-muted dark:text-text-muted-dark',
    'hover:text-text dark:hover:text-white',
    'hover:border-border-secondary dark:hover:border-white/20',
    'shadow-sm hover:shadow transition-all cursor-pointer',
);

interface ChatPanelProps {
    open: boolean;
    onClose: () => void;
}

export function ChatPanel({ open, onClose }: ChatPanelProps) {
    if (!open) return null;

    return (
        <div
            className={cn(
                'relative h-full shrink-0 flex flex-col',
                'w-[380px]',
                'bg-white dark:bg-surface-dark',
                'border-r border-border dark:border-white/6',
            )}
        >
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <ChatInterface />
            </div>

            <button onClick={onClose} className={borderToggleClass}>
                <ChevronLeft className="w-3 h-3" />
            </button>
        </div>
    );
}

export function ChatPanelExpandButton({ onClick }: { onClick: () => void }) {
    return (
        <button onClick={onClick} className={borderToggleClass}>
            <ChevronRight className="w-3 h-3" />
        </button>
    );
}
