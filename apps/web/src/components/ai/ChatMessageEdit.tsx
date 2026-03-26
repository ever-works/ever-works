'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ChatMessageEditProps {
    content: string;
    onChange: (content: string) => void;
    onSave: () => void;
    onCancel: () => void;
}

export function ChatMessageEdit({ content, onChange, onSave, onCancel }: ChatMessageEditProps) {
    const t = useTranslations('dashboard.aiChat');
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const autoResize = () => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    };

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.focus();
            autoResize();
        }
    }, []);

    return (
        <div className="flex flex-col gap-2">
            <textarea
                ref={textareaRef}
                value={content}
                rows={1}
                onChange={(e) => {
                    onChange(e.target.value);
                    autoResize();
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        onSave();
                    }
                    if (e.key === 'Escape') {
                        onCancel();
                    }
                }}
                className={cn(
                    'w-full min-w-48 resize-none rounded-md bg-black/5 dark:bg-white/5 px-2 py-1.5',
                    'text-xs text-text dark:text-white placeholder:text-text-muted dark:placeholder:text-white/40',
                    'focus:outline-none focus:ring-1 focus:ring-primary/30 dark:focus:ring-white/20',
                    'max-h-48 overflow-y-auto',
                )}
            />
            <div className="flex items-center justify-end gap-1.5">
                <button
                    type="button"
                    onClick={onCancel}
                    className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-secondary dark:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 hover:text-text dark:hover:text-white transition-colors"
                >
                    <X className="w-3 h-3" />
                    {t('cancelEdit')}
                </button>
                <button
                    type="button"
                    onClick={onSave}
                    disabled={!content.trim()}
                    className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] bg-primary/15 dark:bg-white/20 text-primary dark:text-white hover:bg-primary/25 dark:hover:bg-white/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    <Check className="w-3 h-3" />
                    {t('saveEdit')}
                </button>
            </div>
        </div>
    );
}
