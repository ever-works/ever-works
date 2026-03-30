'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChatInterface } from './ChatInterface';
import { ChevronLeft, Bot } from 'lucide-react';

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

export function ChatPanel({ open, onClose, className, style }: ChatPanelProps & { className?: string; style?: React.CSSProperties }) {
    // Skip transition on first render to avoid flash when restoring from localStorage
    const hasMounted = useRef(false);
    useEffect(() => {
        requestAnimationFrame(() => {
            hasMounted.current = true;
        });
    }, []);

    return (
        <div
            className={cn('relative h-full shrink-0', hasMounted.current && 'transition-all duration-200', className)}
            style={style}
        >
            <div
                className={cn(
                    'absolute inset-0 flex flex-col overflow-hidden',
                    'bg-white dark:bg-surface-dark',
                    'border-r border-border dark:border-border-dark',
                    hasMounted.current && 'transition-opacity duration-200',
                    open ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
            >
                <div className="flex-1 flex flex-col min-h-0 w-full">
                    <ChatInterface />
                </div>
            </div>
        </div>
    );
}

export function ChatPanelExpandButton({ onClick }: { onClick: () => void }) {
    return (
        <button onClick={onClick} className={borderToggleClass}>
            <Bot className="w-3.5 h-3.5" />
        </button>
    );
}
