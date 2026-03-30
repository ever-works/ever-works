'use client';

import { FormEvent, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { SendHorizonal, Square } from 'lucide-react';

interface ChatInputProps {
    isStreaming: boolean;
    onSubmit: (text: string) => void;
    onStop: () => void;
}

export function ChatInput({ isStreaming, onSubmit, onStop }: ChatInputProps) {
    const t = useTranslations('dashboard.aiChat');
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const inputRef = useRef('');

    // Auto-focus when AI finishes generating
    useEffect(() => {
        if (!isStreaming && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [isStreaming]);

    const autoResize = () => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmed = inputRef.current.trim();
        if (!trimmed || isStreaming) return;
        onSubmit(trimmed);
        inputRef.current = '';
        if (textareaRef.current) {
            textareaRef.current.value = '';
            textareaRef.current.style.height = 'auto';
        }
    };

    return (
        <div className="mt-auto px-4 pb-4 pt-2 shrink-0">
            <form onSubmit={handleSubmit}>
                <div
                    className={cn(
                        'relative flex flex-col rounded-xl border transition-colors',
                        'bg-white dark:bg-surface-dark',
                        'border-border dark:border-white/8',
                        'focus-within:border-primary/40 dark:focus-within:border-white/15',
                        'shadow-sm',
                    )}
                >
                    <textarea
                        ref={textareaRef}
                        defaultValue=""
                        rows={1}
                        onChange={(e) => {
                            inputRef.current = e.target.value;
                            autoResize();
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if (inputRef.current.trim() && !isStreaming) {
                                    e.currentTarget.form?.requestSubmit();
                                }
                            }
                        }}
                        placeholder={t('inputPlaceholder')}
                        className={cn(
                            'w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm',
                            'text-text dark:text-white',
                            'placeholder:text-xs placeholder:text-text-muted dark:placeholder:text-white/25',
                            'focus:outline-none',
                            'max-h-40 overflow-y-auto',
                        )}
                        disabled={isStreaming}
                        autoComplete="off"
                    />
                    <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
                        <span className="text-[10px] text-text-muted dark:text-white/20 select-none">
                            {t('sendHint')}
                        </span>
                        {isStreaming ? (
                            <button
                                type="button"
                                onClick={onStop}
                                aria-label="Stop generating"
                                className="flex cursor-pointer items-center justify-center w-7 h-7 rounded-lg bg-danger/10 text-danger hover:bg-danger/20 transition-all duration-150"
                            >
                                <Square className="w-3 h-3" />
                            </button>
                        ) : (
                            <button
                                type="submit"
                                aria-label={t('sendButton')}
                                className={cn(
                                    'flex cursor-pointer items-center justify-center w-7 h-7 rounded-lg transition-all duration-150',
                                    'bg-primary dark:bg-primary/80 text-white hover:bg-primary-hover dark:hover:bg-primary/90 shadow-sm',
                                )}
                            >
                                <SendHorizonal className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                </div>
            </form>
        </div>
    );
}
