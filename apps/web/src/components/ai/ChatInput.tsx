'use client';

import { DragEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Mic, SendHorizonal, Square } from 'lucide-react';
import {
    ChatAttachButton,
    ChatAttachmentChips,
    filesFromDataTransfer,
    useChatAttachments,
} from './ChatAttachments';
import { useDictation } from '@/components/common/composer/use-dictation';
import { VoiceBar } from '@/components/common/composer/VoiceBar';
import type { ChatAttachmentRef } from '@/lib/ai/attachments';

interface ChatInputProps {
    isStreaming: boolean;
    onSubmit: (text: string, attachments: ReadonlyArray<ChatAttachmentRef>) => void;
    onStop: () => void;
}

const MAX_TEXTAREA_HEIGHT = 160;

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
        el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    };

    // An attachment with no text is a legitimate message ("here, look at
    // this"), so send unlocks on EITHER. What it must never do is fire
    // while an upload is in flight — that would drop the file silently,
    // which is the failure this surface exists to prevent.
    const canSend = !isStreaming && !uploading && (hasText || items.some((i) => i.ref));

    /* ------------------------------------------------------------------ */
    /* Dictation — same engine and bar as the /works composer             */
    /* ------------------------------------------------------------------ */

    // Writes straight to the DOM node and `inputRef` because the textarea is
    // uncontrolled; going through state here would re-render the panel on
    // every recognized phrase.
    const writeValue = useCallback((next: string) => {
        inputRef.current = next;
        setHasText(next.trim().length > 0);
        const el = textareaRef.current;
        if (!el) return;
        el.value = next;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    }, []);

    // Everything this dictation session appended, so "discard" can put the
    // message back exactly as it was instead of clearing the whole field.
    const dictatedRef = useRef('');

    // Dictated text is APPENDED to whatever is already typed, never sent on
    // its own — the user still reads it and presses send.
    const appendDictated = useCallback(
        (text: string) => {
            const existing = inputRef.current;
            const separator = existing.length > 0 && !/\s$/.test(existing) ? ' ' : '';
            const next = `${existing}${separator}${text}`;
            dictatedRef.current += next.slice(existing.length);
            writeValue(next);
        },
        [writeValue],
    );

    const dictation = useDictation(appendDictated);

    const startDictation = useCallback(() => {
        dictatedRef.current = '';
        dictation.start();
    }, [dictation]);

    const finishDictation = useCallback(() => {
        dictation.stop();
        dictatedRef.current = '';
        textareaRef.current?.focus();
    }, [dictation]);

    const discardDictation = useCallback(() => {
        dictation.stop();
        const appended = dictatedRef.current;
        dictatedRef.current = '';
        const current = inputRef.current;
        // Only rewind when the tail is still verbatim ours; if the user
        // edited mid-dictation we leave their text alone rather than
        // guessing which part to cut.
        if (appended && current.endsWith(appended)) {
            writeValue(current.slice(0, current.length - appended.length));
        }
        textareaRef.current?.focus();
    }, [dictation, writeValue]);

    // A composer that goes disabled mid-sentence (a reply started streaming)
    // must not leave the mic open behind it.
    const { listening: dictating, stop: stopDictation } = dictation;
    useEffect(() => {
        if (isStreaming && dictating) stopDictation();
    }, [isStreaming, dictating, stopDictation]);

    // Starting dictation unmounts the mic button (the toolbar becomes the
    // VoiceBar), which would drop keyboard focus to <body>. Park it on the
    // textarea instead — the caret sits where the words are landing, and the
    // bar's discard / keep buttons are the next tab stops.
    useEffect(() => {
        if (dictating) textareaRef.current?.focus();
    }, [dictating]);

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmed = inputRef.current.trim();
        const ready = readyRefs();
        if (isStreaming || uploading) return;
        if (!trimmed && ready.length === 0) return;
        onSubmit(trimmed, ready);
        inputRef.current = '';
        dictatedRef.current = '';
        setHasText(false);
        clear();
        if (textareaRef.current) {
            textareaRef.current.value = '';
            textareaRef.current.style.height = 'auto';
        }
    };

    const toolbarButtonClass = cn(
        'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors',
        'text-text-muted hover:bg-card-hover hover:text-text',
        'dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/40',
        'disabled:cursor-not-allowed disabled:opacity-40',
    );

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

                    {/* Recording is a MODE, not one more lit-up button: the bar
                        takes the toolbar's place for as long as the mic is
                        open, exactly as it does in the /works composer. */}
                    {dictating && dictation.startedAt !== null ? (
                        <VoiceBar
                            startedAt={dictation.startedAt}
                            canvasRef={dictation.canvasRef}
                            waveformActive={dictation.waveformActive}
                            onCancel={discardDictation}
                            onDone={finishDictation}
                            testId="chat-composer"
                        />
                    ) : (
                        <div
                            className={cn(
                                'flex items-center gap-0.5 px-2 pb-2 pt-1.5',
                                'border-t border-border/[0.15] dark:border-white/[0.06]',
                            )}
                        >
                            <ChatAttachButton onFiles={addFiles} disabled={isStreaming} />
                            {dictation.supported ? (
                                <button
                                    type="button"
                                    onClick={startDictation}
                                    disabled={isStreaming}
                                    aria-label={t('dictation.start')}
                                    title={t('dictation.start')}
                                    data-testid="chat-dictation-button"
                                    className={toolbarButtonClass}
                                >
                                    <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                            ) : null}

                            {/* The panel is user-resizable, so this hint is the
                                one thing here that must give way: truncating it
                                keeps the controls and the send button in place
                                at any width instead of crowding them out. */}
                            <span
                                title={t('sendHint')}
                                className="min-w-0 truncate pl-1 text-[10px] text-text-muted dark:text-white/20 select-none"
                            >
                                {t('sendHint')}
                            </span>

                            <div className="ml-auto flex shrink-0 items-center pl-2">
                                {isStreaming ? (
                                    <button
                                        type="button"
                                        onClick={onStop}
                                        aria-label={t('stopGenerating')}
                                        className="flex shrink-0 cursor-pointer items-center justify-center w-7 h-7 rounded-lg bg-danger/10 text-danger hover:bg-danger/20 transition-all duration-150"
                                    >
                                        <Square className="w-3 h-3" />
                                    </button>
                                ) : (
                                    <button
                                        type="submit"
                                        disabled={!canSend}
                                        aria-label={t('sendButton')}
                                        className={cn(
                                            'flex shrink-0 cursor-pointer items-center justify-center w-7 h-7 rounded-lg transition-all duration-150',
                                            'bg-primary dark:bg-primary/80 text-white hover:bg-primary-hover dark:hover:bg-primary/90 shadow-sm',
                                            'disabled:cursor-not-allowed disabled:opacity-40',
                                        )}
                                    >
                                        <SendHorizonal className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </form>
        </div>
    );
}
