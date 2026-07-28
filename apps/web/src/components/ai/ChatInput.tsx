'use client';

import { DragEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { SendHorizonal, Square } from 'lucide-react';
import {
    ChatAttachButton,
    ChatAttachmentChips,
    filesFromDataTransfer,
    useChatAttachments,
} from './ChatAttachments';
import type { ChatAttachmentRef } from '@/lib/ai/attachments';

interface ChatInputProps {
    isStreaming: boolean;
    onSubmit: (text: string, attachments: ReadonlyArray<ChatAttachmentRef>) => void;
    onStop: () => void;
}

export function ChatInput({ isStreaming, onSubmit, onStop }: ChatInputProps) {
    const t = useTranslations('dashboard.aiChat');
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const inputRef = useRef('');
    const { items, addFiles, remove, clear, readyRefs, uploading } = useChatAttachments();
    const [dragging, setDragging] = useState(false);
    // Mirrors `inputRef` into state ONLY so the send button can re-evaluate
    // its enabled state. The textarea stays uncontrolled — making it
    // controlled would re-render the panel on every keystroke — so this
    // tracks emptiness, not the text itself.
    const [hasText, setHasText] = useState(false);

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

    // An attachment with no text is a legitimate message ("here, look at
    // this"), so send unlocks on EITHER. What it must never do is fire
    // while an upload is in flight — that would drop the file silently,
    // which is the failure this surface exists to prevent.
    const canSend = !isStreaming && !uploading && (hasText || items.some((i) => i.ref));

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmed = inputRef.current.trim();
        const ready = readyRefs();
        if (isStreaming || uploading) return;
        if (!trimmed && ready.length === 0) return;
        onSubmit(trimmed, ready);
        inputRef.current = '';
        setHasText(false);
        clear();
        if (textareaRef.current) {
            textareaRef.current.value = '';
            textareaRef.current.style.height = 'auto';
        }
    };

    return (
        <div className="mt-auto px-4 pb-4 pt-2 shrink-0">
            <form onSubmit={handleSubmit}>
                <div
                    data-testid="chat-composer"
                    onDragOver={(e: DragEvent<HTMLDivElement>) => {
                        e.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e: DragEvent<HTMLDivElement>) => {
                        e.preventDefault();
                        setDragging(false);
                        const files = filesFromDataTransfer(e.dataTransfer);
                        if (files.length > 0) addFiles(files);
                    }}
                    className={cn(
                        'relative flex flex-col rounded-xl border transition-colors  max-w-200 mx-auto',
                        'bg-white dark:bg-surface-dark',
                        'border-border dark:border-white/20',
                        'focus-within:border-primary/60 dark:focus-within:border-white/30',
                        dragging && 'border-primary/60 dark:border-primary/60',
                        'shadow-sm',
                    )}
                >
                    <ChatAttachmentChips items={items} onRemove={remove} />
                    <textarea
                        ref={textareaRef}
                        defaultValue=""
                        rows={1}
                        onChange={(e) => {
                            inputRef.current = e.target.value;
                            setHasText(e.target.value.trim().length > 0);
                            autoResize();
                        }}
                        onPaste={(e) => {
                            // Pasting a screenshot is the fastest way to attach
                            // one; without this the clipboard image is dropped
                            // and only its (usually empty) text survives.
                            const files = filesFromDataTransfer(e.clipboardData);
                            if (files.length > 0) {
                                e.preventDefault();
                                addFiles(files);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if (canSend) {
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
                        <div className="flex items-center gap-1">
                            <ChatAttachButton onFiles={addFiles} disabled={isStreaming} />
                            <span className="text-[10px] text-text-muted dark:text-white/20 select-none">
                                {t('sendHint')}
                            </span>
                        </div>
                        {isStreaming ? (
                            <button
                                type="button"
                                onClick={onStop}
                                aria-label={t('stopGenerating')}
                                className="flex cursor-pointer items-center justify-center w-7 h-7 rounded-lg bg-danger/10 text-danger hover:bg-danger/20 transition-all duration-150"
                            >
                                <Square className="w-3 h-3" />
                            </button>
                        ) : (
                            <button
                                type="submit"
                                disabled={!canSend}
                                aria-label={t('sendButton')}
                                className={cn(
                                    'flex cursor-pointer items-center justify-center w-7 h-7 rounded-lg transition-all duration-150',
                                    'bg-primary dark:bg-primary/80 text-white hover:bg-primary-hover dark:hover:bg-primary/90 shadow-sm',
                                    'disabled:cursor-not-allowed disabled:opacity-40',
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
