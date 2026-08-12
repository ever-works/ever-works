'use client';

import { DragEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Mic, SendHorizonal, Square } from 'lucide-react';
import {
    ChatAttachButton,
    ChatAttachmentChips,
    filesFromDataTransfer,
    useChatAttachments,
} from './ChatAttachments';
import { ChatDictation } from './ChatDictation';
import { useDictation } from '@/components/common/composer/use-dictation';
import { VoiceBar } from '@/components/common/composer/VoiceBar';
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

    // Dictated text is APPENDED to whatever is already typed, never sent
    // on its own — the user still reads it and presses send. The textarea
    // is uncontrolled, so the DOM value and `inputRef` are updated
    // together and `hasText` re-enables the send button.
    const appendDictated = (text: string) => {
        const el = textareaRef.current;
        const existing = inputRef.current;
        const next = existing ? `${existing.replace(/\s*$/, '')} ${text}` : text;
        inputRef.current = next;
        setHasText(next.trim().length > 0);
        if (el) {
            el.value = next;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            el.focus();
        }
    };

    /* ------------------------------------------------------------------ */
    /* Live dictation — the /works composer's engine and bar              */
    /*                                                                    */
    /* One mic, two possible engines behind it. This one recognizes in    */
    /* the browser, so text lands while you speak and no audio leaves the */
    /* device — but it exists only where the Web Speech API does. Where   */
    /* it doesn't, ChatDictation takes the same slot and records-and-     */
    /* uploads instead. Both feed `appendDictated`, so either way the     */
    /* text is appended and never sent on its own.                        */
    /* ------------------------------------------------------------------ */

    // Everything this dictation session appended, so "discard" can put the
    // message back exactly as it was instead of clearing the whole field.
    const dictatedRef = useRef('');

    // Wraps `appendDictated` instead of duplicating it: measure the field
    // before and after so what gets recorded is exactly what landed,
    // separator included. Plain function, like its neighbours — useDictation
    // parks the callback in a ref, so its identity never matters.
    const appendLive = (text: string) => {
        const before = inputRef.current;
        appendDictated(text);
        dictatedRef.current += inputRef.current.slice(before.length);
    };

    const dictation = useDictation(appendLive);

    // `useDictation` can only detect Web Speech from a mount effect, so its
    // first render always reports "unsupported". Picking the engine on that
    // frame would mount ChatDictation in Chrome too, firing its authenticated
    // providers request on every load before unmounting. Wait for the same
    // effect flush that sets `supported` and choose once.
    const [engineResolved, setEngineResolved] = useState(false);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: pairs with the capability detection inside useDictation, which is only knowable after mount.
        setEngineResolved(true);
    }, []);

    const startDictation = () => {
        dictatedRef.current = '';
        dictation.start();
    };

    const finishDictation = () => {
        dictation.stop();
        dictatedRef.current = '';
        textareaRef.current?.focus();
    };

    const discardDictation = () => {
        dictation.stop();
        const appended = dictatedRef.current;
        dictatedRef.current = '';
        const current = inputRef.current;
        // Only rewind when the tail is still verbatim ours; if the user
        // edited mid-dictation we leave their text alone rather than
        // guessing which part to cut.
        if (appended && current.endsWith(appended)) {
            const next = current.slice(0, current.length - appended.length);
            inputRef.current = next;
            setHasText(next.trim().length > 0);
            const el = textareaRef.current;
            if (el) {
                el.value = next;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }
        }
        textareaRef.current?.focus();
    };

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
                    {/* Live dictation is a MODE, not one more lit-up button:
                        the bar takes the toolbar's place for as long as the
                        mic is open, exactly as it does in the /works composer. */}
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
                        <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
                            <div className="flex min-w-0 flex-1 items-center gap-1">
                                <ChatAttachButton onFiles={addFiles} disabled={isStreaming} />
                                {/* ONE mic, not one per engine. Where the
                                    browser speaks (Chrome / Edge / Safari) it
                                    drives the live engine and ChatDictation is
                                    reduced to its provider picker; elsewhere
                                    ChatDictation supplies both the mic and the
                                    picker and records-and-uploads instead.
                                    Either way the user sees one mic, because
                                    to them it is one gesture. */}
                                {!engineResolved ? null : dictation.supported ? (
                                    <>
                                        <ChatDictation
                                            onText={appendDictated}
                                            disabled={isStreaming}
                                            pickerOnly
                                        />
                                        <button
                                            type="button"
                                            onClick={startDictation}
                                            disabled={isStreaming}
                                            aria-label={t('dictation.start')}
                                            title={t('dictation.start')}
                                            data-testid="chat-dictation-button"
                                            className={cn(
                                                'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors',
                                                'text-text-muted hover:bg-card-hover hover:text-text',
                                                'dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white',
                                                'disabled:cursor-not-allowed disabled:opacity-40',
                                            )}
                                        >
                                            <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                                        </button>
                                    </>
                                ) : (
                                    <ChatDictation onText={appendDictated} disabled={isStreaming} />
                                )}
                                {/* The panel is user-resizable, so this hint is the
                                one thing here that must give way: truncating it
                                keeps the controls and the send button in place
                                at any width instead of crowding them out. */}
                                <span
                                    title={t('sendHint')}
                                    className="min-w-0 truncate text-[10px] text-text-muted dark:text-white/20 select-none"
                                >
                                    {t('sendHint')}
                                </span>
                            </div>
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
                    )}
                </div>
            </form>
        </div>
    );
}
