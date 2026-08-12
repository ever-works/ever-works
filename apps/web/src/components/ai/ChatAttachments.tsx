'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Loader2, Paperclip, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { uploadFile, UploadError } from '@/lib/api/uploads';
import { AttachmentPreview } from '@/components/common/composer/AttachmentPreview';
import {
    isImageFile,
    isPreviewableAttachment,
    type ComposerFileAttachment,
} from '@/components/common/composer/attachments';
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
 *
 * An attachment keeps the picked `File`, which is what makes preview
 * possible: images render from a local object URL and text / code / CSV
 * documents are read off the file itself, so both open the moment they are
 * picked rather than after the upload lands. The overlay is the /works
 * composer's `AttachmentPreview`, shared rather than reimplemented — the
 * chat panel is narrower, so only the strip differs (compact chips instead
 * of 64px tiles); what opens out of them is identical.
 */

/**
 * Structurally a `ComposerFileAttachment` so the shared preview overlay
 * accepts it as-is, plus the resolved `ref` the chat send path forwards.
 */
export interface ChatAttachment extends ComposerFileAttachment {
    readonly kind: 'file';
    /** Set once the upload resolves. */
    ref?: ChatAttachmentRef;
}

/** Matches the API's own default cap so the user is told before the wire. */
const MAX_BYTES = 25 * 1024 * 1024;

let seq = 0;
const nextLocalId = () => `att-${Date.now()}-${(seq += 1)}`;

export function useChatAttachments() {
    const t = useTranslations('dashboard.aiChat.attachments');
    const [items, setItems] = useState<ChatAttachment[]>([]);
    const itemsRef = useRef<ChatAttachment[]>([]);
    useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    // An object URL pins the whole file in memory until revoked, so every one
    // minted here is tracked and released on removal, clear and unmount.
    const objectUrlsRef = useRef<Set<string>>(new Set());
    const releaseUrl = useCallback((url: string | undefined) => {
        if (!url || !objectUrlsRef.current.has(url)) return;
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(url);
    }, []);
    useEffect(
        () => () => {
            objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
            objectUrlsRef.current.clear();
        },
        [],
    );

    const patch = useCallback((localId: string, changes: Partial<ChatAttachment>) => {
        setItems((prev) => prev.map((i) => (i.localId === localId ? { ...i, ...changes } : i)));
    }, []);

    const addFiles = useCallback(
        (files: FileList | File[]) => {
            const list = Array.from(files);
            if (list.length === 0) return;

            const staged: ChatAttachment[] = list.map((file) => {
                const tooLarge = file.size > MAX_BYTES;

                // Minted at pick time so an image's thumbnail and preview are
                // there immediately, not once the upload resolves.
                let previewUrl: string | undefined;
                if (isImageFile(file)) {
                    try {
                        previewUrl = URL.createObjectURL(file);
                        objectUrlsRef.current.add(previewUrl);
                    } catch {
                        /* no thumbnail — degrades to the file glyph */
                    }
                }

                return {
                    kind: 'file' as const,
                    localId: nextLocalId(),
                    file,
                    displayName: file.name,
                    progress: 0,
                    uploading: !tooLarge,
                    previewUrl,
                    error: tooLarge ? t('tooLarge') : undefined,
                };
            });
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
                            uploading: false,
                            url: res.url,
                            mimeType: res.mimeType,
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
                            uploading: false,
                            error: err instanceof UploadError ? err.message : t('failed'),
                        });
                    });
            });
        },
        [patch, t],
    );

    const remove = useCallback(
        (localId: string) => {
            // Revoked outside the updater — state updaters must stay pure
            // (StrictMode runs them twice in development).
            releaseUrl(itemsRef.current.find((i) => i.localId === localId)?.previewUrl);
            setItems((prev) => prev.filter((i) => i.localId !== localId));
        },
        [releaseUrl],
    );
    const clear = useCallback(() => {
        itemsRef.current.forEach((i) => releaseUrl(i.previewUrl));
        setItems([]);
    }, [releaseUrl]);

    /** Only fully-uploaded attachments are worth sending. */
    const readyRefs = useCallback(
        () => itemsRef.current.map((i) => i.ref).filter((r): r is ChatAttachmentRef => Boolean(r)),
        [],
    );
    const uploading = items.some((i) => i.uploading);

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
    const previewable = useMemo(() => items.filter(isPreviewableAttachment), [items]);
    const [previewId, setPreviewId] = useState<string | null>(null);
    const previewIndex = previewId ? previewable.findIndex((a) => a.localId === previewId) : -1;

    if (items.length === 0) return null;

    return (
        <>
            <ul data-testid="chat-attachment-chips" className="flex flex-wrap gap-1.5 px-3 pt-2">
                {items.map((item) => {
                    const canPreview = isPreviewableAttachment(item) && !item.error;
                    const face =
                        item.previewUrl && !item.error ? (
                            /* eslint-disable-next-line @next/next/no-img-element --
                               local `blob:` object URL for a just-picked file;
                               nothing for next/image to optimize or allowlist. */
                            <img
                                src={item.previewUrl}
                                alt=""
                                decoding="async"
                                className="size-3.5 shrink-0 rounded-sm object-cover"
                            />
                        ) : item.uploading ? (
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                        ) : (
                            <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                        );

                    return (
                        <li
                            key={item.localId}
                            data-testid="chat-attachment-chip"
                            className={cn(
                                'flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]',
                                item.error
                                    ? 'border-red-500/40 text-red-600 dark:text-red-400'
                                    : 'border-border text-text-muted dark:border-white/15 dark:text-white/60',
                            )}
                            title={item.error ?? item.displayName}
                        >
                            {/* The chip body opens the preview; the remove
                                button stays outside it so removing never also
                                opens the overlay on the way out. */}
                            {canPreview ? (
                                <button
                                    type="button"
                                    onClick={() => setPreviewId(item.localId)}
                                    aria-label={t('preview', { name: item.displayName })}
                                    data-testid="chat-attachment-preview"
                                    className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded underline-offset-2 hover:text-text hover:underline dark:hover:text-white"
                                >
                                    {face}
                                    <span className="truncate">{item.displayName}</span>
                                </button>
                            ) : (
                                <>
                                    {face}
                                    <span className="truncate">{item.displayName}</span>
                                </>
                            )}
                            {item.uploading ? <span>{item.progress}%</span> : null}
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
                    );
                })}
            </ul>

            {previewIndex >= 0 ? (
                <AttachmentPreview
                    attachments={previewable}
                    index={previewIndex}
                    onIndexChange={(next) => setPreviewId(previewable[next]?.localId ?? null)}
                    onClose={() => setPreviewId(null)}
                    testId="chat-attachment"
                />
            ) : null}
        </>
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
