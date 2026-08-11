'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Loader2, Paperclip, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { uploadFile, UploadError } from '@/lib/api/uploads';
import type { ChatAttachmentRef } from '@/lib/ai/attachments';

/**
 * Attachment strip + picker for the chat composer.
 *
 * The chat panel was the ONE prompt surface with no way to attach a file:
 * `/new`, `/works/new`, `/missions`, `/ideas` and `/agents` all have the
 * PromptComposer's `+` button, and the agent system prompt has always
 * documented an "Attached files" block — it just described a control the
 * chat UI did not have. Files attached elsewhere reached chat; files a
 * user wanted to attach *in* chat had nowhere to go.
 *
 * Files upload IMMEDIATELY on selection rather than on send, through the
 * existing owner-scoped `/api/uploads/file` spine. Two reasons: the user
 * sees progress while still typing, and by send time every attachment is
 * either a resolved URL or visibly failed — the send path never has to
 * reason about an in-flight upload.
 *
 * A failed upload stays on screen with its error rather than vanishing.
 * Dropping it silently would let someone send a message believing a file
 * went with it.
 *
 * Intake lives in the HOOK, not the component, so the picker, drag-drop
 * and paste all reach the same code path instead of three copies drifting.
 */

export interface ChatAttachment {
    /** Stable client id — a File has no natural key before upload. */
    readonly localId: string;
    readonly name: string;
    readonly size: number;
    /** 0-100 while uploading. */
    progress: number;
    /** Set once the upload resolves. */
    ref?: ChatAttachmentRef;
    error?: string;
}

/** Matches the API's own default cap so the user is told before the wire. */
const MAX_BYTES = 25 * 1024 * 1024;

let seq = 0;
const nextLocalId = () => `att-${Date.now()}-${(seq += 1)}`;

export function useChatAttachments() {
    const t = useTranslations('dashboard.aiChat.attachments');
    const [items, setItems] = useState<ChatAttachment[]>([]);
    const itemsRef = useRef<ChatAttachment[]>([]);
    itemsRef.current = items;

    const patch = useCallback((localId: string, changes: Partial<ChatAttachment>) => {
        setItems((prev) => prev.map((i) => (i.localId === localId ? { ...i, ...changes } : i)));
    }, []);

    const addFiles = useCallback(
        (files: FileList | File[]) => {
            const list = Array.from(files);
            if (list.length === 0) return;

            const staged: ChatAttachment[] = list.map((file) => ({
                localId: nextLocalId(),
                name: file.name,
                size: file.size,
                progress: 0,
                error: file.size > MAX_BYTES ? t('tooLarge') : undefined,
            }));
            setItems((prev) => [...prev, ...staged]);

            list.forEach((file, index) => {
                const entry = staged[index];
                if (entry.error) return;
                uploadFile(file, {
                    onProgress: (percent) => patch(entry.localId, { progress: percent }),
                })
                    .then((res) => {
                        patch(entry.localId, {
                            progress: 100,
                            ref: {
                                name: res.filename || file.name,
                                url: res.url,
                                mimeType: res.mimeType,
                                kind: 'upload',
                            },
                        });
                    })
                    .catch((err: unknown) => {
                        patch(entry.localId, {
                            error: err instanceof UploadError ? err.message : t('failed'),
                        });
                    });
            });
        },
        [patch, t],
    );

    const remove = useCallback(
        (localId: string) => setItems((prev) => prev.filter((i) => i.localId !== localId)),
        [],
    );
    const clear = useCallback(() => setItems([]), []);

    /** Only fully-uploaded attachments are worth sending. */
    const readyRefs = useCallback(
        () => itemsRef.current.map((i) => i.ref).filter((r): r is ChatAttachmentRef => Boolean(r)),
        [],
    );
    const uploading = items.some((i) => !i.ref && !i.error);

    return { items, addFiles, remove, clear, readyRefs, uploading };
}

export function ChatAttachmentChips({
    items,
    onRemove,
}: {
    readonly items: ChatAttachment[];
    readonly onRemove: (localId: string) => void;
}) {
    const t = useTranslations('dashboard.aiChat.attachments');
    if (items.length === 0) return null;
    return (
        <ul data-testid="chat-attachment-chips" className="flex flex-wrap gap-1.5 px-3 pt-2">
            {items.map((item) => (
                <li
                    key={item.localId}
                    data-testid="chat-attachment-chip"
                    className={cn(
                        'flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]',
                        item.error
                            ? 'border-red-500/40 text-red-600 dark:text-red-400'
                            : 'border-border text-text-muted dark:border-white/15 dark:text-white/60',
                    )}
                    title={item.error ?? item.name}
                >
                    {item.ref || item.error ? (
                        <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                    ) : (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                    )}
                    <span className="truncate">{item.name}</span>
                    {!item.ref && !item.error ? <span>{item.progress}%</span> : null}
                    <button
                        type="button"
                        aria-label={t('remove')}
                        data-testid="chat-attachment-remove"
                        onClick={() => onRemove(item.localId)}
                        className="ml-0.5 shrink-0 rounded hover:text-text dark:hover:text-white"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </li>
            ))}
        </ul>
    );
}

export function ChatAttachButton({
    onFiles,
    disabled,
}: {
    readonly onFiles: (files: FileList | File[]) => void;
    readonly disabled?: boolean;
}) {
    const t = useTranslations('dashboard.aiChat.attachments');
    const inputRef = useRef<HTMLInputElement | null>(null);
    return (
        <>
            <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                data-testid="chat-attachment-input"
                onChange={(e) => {
                    if (e.target.files) onFiles(e.target.files);
                    // Reset so picking the same file twice still fires.
                    e.target.value = '';
                }}
            />
            <button
                type="button"
                disabled={disabled}
                aria-label={t('attach')}
                data-testid="chat-attachment-button"
                onClick={() => inputRef.current?.click()}
                className={cn(
                    'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors',
                    'text-text-muted hover:bg-card-hover hover:text-text',
                    'dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                )}
            >
                <Paperclip className="h-3.5 w-3.5" />
            </button>
        </>
    );
}

/** Shared by drop and paste so both reach the same intake path. */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    if (dt.files && dt.files.length > 0) return Array.from(dt.files);
    return Array.from(dt.items ?? [])
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter((f): f is File => Boolean(f));
}
