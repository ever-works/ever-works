'use client';

import {
    ArrowUp,
    File as FileIcon,
    Folder,
    Github,
    Image as ImageIcon,
    Loader2,
    Mic,
    Paperclip,
    Plus,
} from 'lucide-react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ClipboardEvent,
    type DragEvent,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils/cn';
import { uploadFile, UploadError } from '@/lib/api/uploads';
import { SlashCommandPopup, useSlashCommands } from '@/components/skills/SlashCommandAutocomplete';
import { AttachmentStrip } from './composer/AttachmentStrip';
import { AttachmentPreview } from './composer/AttachmentPreview';
import { VoiceBar } from './composer/VoiceBar';
import { useDictation } from './composer/use-dictation';
import {
    buildAttachmentRefs,
    formatBytes,
    isImageFile,
    isPreviewableAttachment,
    MAX_UPLOAD_BYTES,
    type ComposerAttachment,
    type ComposerAttachmentRef,
    type ComposerFileAttachment,
} from './composer/attachments';

/**
 * Shared prompt composer used by `/missions`, `/ideas`, `/new`, `/agents`
 * and `/works/new`. Modeled on the website's `LandingPromptForm` so the
 * dashboard's prompt surfaces read the same way visitors first met the
 * product, and on the ergonomics people now expect from a chat composer:
 *
 *   - Rounded card on the page's natural background, growing with the text
 *     up to `maxHeight` instead of a fixed `rows` box.
 *   - Typewriter placeholder cycling through example briefs.
 *   - Images attach as thumbnails, documents as cards with type + size +
 *     progress, and a picked folder as one expandable card. Images and text
 *     documents open full size in `AttachmentPreview`.
 *   - Files can arrive three ways — the `+` menu, drag-and-drop onto the
 *     card, or pasting a screenshot straight into the textarea.
 *   - Dictation swaps the toolbar for a recording bar with a live mic
 *     meter, elapsed time, and discard / keep actions (`VoiceBar`).
 *   - Optional `chipsBelow` slot for generation-type chip strips (rendered
 *     OUTSIDE / BELOW the card) so the chip row mirrors the website.
 *   - Enter submits; Shift+Enter inserts a newline; Cmd/Ctrl+Enter submits
 *     from anywhere in the text.
 *
 * Palette: design-system tokens only — neutral surfaces, `button-primary`
 * for the send/confirm affordance, and `danger` / `warning` for state. The
 * brand accent is deliberately absent: this is chrome around the user's own
 * words, not a call to action competing with them.
 */
const TYPE_MS = 35;
const ERASE_MS = 18;
const HOLD_TYPED_MS = 1800;
const HOLD_ERASED_MS = 350;

// GitHub repo URL validator. Accepts the canonical
// `https://github.com/<owner>/<repo>` shape (optionally trailing slash,
// `.git`, or extra path segments). The chat / canvas flows do deeper
// validation; this is just to keep obvious garbage out of the picker.
const GITHUB_REPO_RE =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[/?#].*)?$/i;

let idSeq = 0;
function nextLocalId(prefix: string): string {
    idSeq += 1;
    return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

function useTypewriterPlaceholder(
    focused: boolean,
    examples: ReadonlyArray<string>,
    fallback?: string,
): string {
    const [index, setIndex] = useState(0);
    const [shown, setShown] = useState('');
    const [phase, setPhase] = useState<'typing' | 'holding' | 'erasing' | 'paused'>('typing');

    // Reset whenever the examples array reference changes so a
    // parent-controlled list swap (e.g. chip selection on /new)
    // doesn't leave a half-erased stale string on screen.
    useEffect(() => {
        setIndex(0);
        setShown('');
        setPhase(focused ? 'paused' : 'typing');
        // Only react to a *new* examples reference.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [examples]);

    useEffect(() => {
        if (focused) {
            setPhase('paused');
            return;
        }
        if (phase === 'paused') setPhase('typing');
    }, [focused, phase]);

    useEffect(() => {
        if (focused) return;
        if (!examples || examples.length === 0) return;
        const target = examples[index % examples.length];
        let timer: ReturnType<typeof setTimeout>;
        if (phase === 'typing') {
            if (shown.length < target.length) {
                timer = setTimeout(() => setShown(target.slice(0, shown.length + 1)), TYPE_MS);
            } else {
                // Hand off to 'holding' immediately — that phase owns
                // the full HOLD_TYPED_MS pause. Setting a HOLD_TYPED_MS
                // here too would double-count the hold (3.6s total).
                timer = setTimeout(() => setPhase('holding'), 0);
            }
        } else if (phase === 'holding') {
            timer = setTimeout(() => setPhase('erasing'), HOLD_TYPED_MS);
        } else if (phase === 'erasing') {
            if (shown.length > 0) {
                timer = setTimeout(() => setShown(shown.slice(0, -1)), ERASE_MS);
            } else {
                timer = setTimeout(() => {
                    setIndex((i) => (i + 1) % examples.length);
                    setPhase('typing');
                }, HOLD_ERASED_MS);
            }
        }
        return () => clearTimeout(timer);
    }, [phase, shown, index, focused, examples]);

    return shown || examples[0] || fallback || '';
}

/**
 * Rows in the (+) popover, in order. Data rather than four near-identical
 * JSX blocks — the hints are what make the menu self-explanatory (a bare
 * "Upload a file" doesn't tell you a PDF is welcome). `github` is dropped
 * unless the surface opted into repo imports.
 */
const ATTACH_MENU_ITEMS = [
    {
        id: 'image',
        label: 'Add photos',
        hint: 'Or paste a screenshot',
        icon: ImageIcon,
    },
    {
        id: 'file',
        label: 'Upload files',
        hint: 'PDF, docs, data, code',
        icon: FileIcon,
    },
    {
        id: 'folder',
        label: 'Upload a folder',
        hint: 'Everything inside it',
        icon: Folder,
    },
    {
        id: 'github',
        label: 'Import GitHub repo',
        hint: 'Public repository URL',
        icon: Github,
    },
] as const;

type AttachMenuItemId = (typeof ATTACH_MENU_ITEMS)[number]['id'];

/** Drag-and-drop and paste both hand us a DataTransfer-shaped object. */
function filesFrom(data: DataTransfer | null): File[] {
    if (!data) return [];
    if (data.files && data.files.length > 0) return Array.from(data.files);
    return Array.from(data.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
}

/**
 * A file on its way in, with the path it had inside a picked folder. The
 * browser's `File` carries `webkitRelativePath` only for `<input
 * webkitdirectory>` picks — a *dropped* folder gives us the path through the
 * entry API instead, and `webkitRelativePath` is read-only, so the path
 * travels alongside the file rather than on it.
 */
interface PickedFile {
    readonly file: File;
    readonly path?: string;
}

/**
 * The slice of the (non-standard, but universally implemented) drag-and-drop
 * entry API we need to walk a dropped folder. Not in TS's DOM lib.
 */
interface DirectoryEntryLike {
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly name: string;
    file?: (onFile: (file: File) => void, onError?: (error: unknown) => void) => void;
    createReader?: () => {
        readEntries: (
            onEntries: (entries: DirectoryEntryLike[]) => void,
            onError?: (error: unknown) => void,
        ) => void;
    };
}

/**
 * Ceiling on files taken from a single dropped folder. Someone who drags a
 * project directory would otherwise queue thousands of uploads (and every
 * `node_modules` inside it) from one gesture.
 */
const MAX_DROPPED_FOLDER_FILES = 200;

/**
 * Vertical geometry of the textarea, used to turn a `rows` count into the
 * pixel ceiling the auto-growing box stops at: one line of `text-base` at
 * `leading-relaxed`, plus the `pt-4` / `pb-3` padding.
 */
const TEXTAREA_LINE_HEIGHT = 26;
const TEXTAREA_VERTICAL_PADDING = 28;

/**
 * Floor for the ceiling (px) the auto-growing textarea stops at before it
 * scrolls internally. Matches the height of the fixed three-row box the
 * composer used before it grew with its content.
 */
const MAX_TEXTAREA_HEIGHT = 3 * TEXTAREA_LINE_HEIGHT + TEXTAREA_VERTICAL_PADDING;

/**
 * Geometry for the (+) popover. It renders in a portal at the document root
 * rather than next to the button, because the composer card clips its
 * children (`overflow-hidden`, for the rounded corners) and the pages that
 * embed the composer clip theirs — an absolutely positioned menu got sliced
 * off at the card's edge.
 *
 * `MENU_WIDTH` mirrors the old `w-60` and `MENU_EST_HEIGHT` is roughly the
 * tallest the menu gets (four rows); both only feed the flip / clamp
 * decisions, so approximations are fine.
 */
const MENU_WIDTH = 240;
const MENU_EST_HEIGHT = 260;
const MENU_GAP = 8;
const VIEWPORT_MARGIN = 8;

interface MenuPosition {
    readonly left: number;
    /** Set when the menu opens downward. */
    readonly top?: number;
    /** Set when the menu opens upward (the preferred direction). */
    readonly bottom?: number;
}

function measureMenuPosition(button: HTMLElement): MenuPosition {
    const rect = button.getBoundingClientRect();
    const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
    );
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    // Above is the default — content directly under a composer is usually
    // dense — but flip when there genuinely isn't room up there.
    const openAbove = spaceAbove >= MENU_EST_HEIGHT + MENU_GAP || spaceAbove >= spaceBelow;
    if (openAbove) return { left, bottom: window.innerHeight - rect.top + MENU_GAP };
    return { left, top: rect.bottom + MENU_GAP };
}

/**
 * `webkitGetAsEntry()` must be called synchronously inside the drop handler —
 * the item list is emptied as soon as the event finishes. The returned entry
 * objects stay valid afterwards, so the async walk below is safe.
 */
function entriesFrom(data: DataTransfer | null): DirectoryEntryLike[] {
    const entries: DirectoryEntryLike[] = [];
    for (const item of Array.from(data?.items ?? [])) {
        if (item.kind !== 'file') continue;
        const getEntry = (
            item as DataTransferItem & { webkitGetAsEntry?: () => DirectoryEntryLike | null }
        ).webkitGetAsEntry;
        const entry = typeof getEntry === 'function' ? getEntry.call(item) : null;
        if (entry) entries.push(entry);
    }
    return entries;
}

function fileOfEntry(entry: DirectoryEntryLike): Promise<File | null> {
    return new Promise((resolve) => {
        if (!entry.file) {
            resolve(null);
            return;
        }
        entry.file(
            (file) => resolve(file),
            () => resolve(null),
        );
    });
}

/** Depth-first walk of a dropped directory into `{ file, path }` pairs. */
async function walkEntry(
    entry: DirectoryEntryLike,
    prefix: string,
    out: PickedFile[],
    limit: number,
): Promise<void> {
    if (out.length >= limit) return;

    if (entry.isFile) {
        const file = await fileOfEntry(entry);
        if (file) out.push({ file, path: prefix ? `${prefix}/${entry.name}` : entry.name });
        return;
    }
    if (!entry.isDirectory || !entry.createReader) return;

    const reader = entry.createReader();
    const nested = prefix ? `${prefix}/${entry.name}` : entry.name;
    // `readEntries` pages — it must be called until it returns an empty batch.
    for (;;) {
        const batch = await new Promise<DirectoryEntryLike[]>((resolve) => {
            reader.readEntries(
                (items) => resolve(items),
                () => resolve([]),
            );
        });
        if (batch.length === 0) break;
        for (const child of batch) {
            await walkEntry(child, nested, out, limit);
            if (out.length >= limit) return;
        }
    }
}

export interface PromptComposerProps {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    /** Min chars required for submit to be enabled. Defaults to 10. */
    minLength?: number;
    /** Hard cap enforced by the textarea. Defaults to 5000. */
    maxLength?: number;
    /**
     * Starting height of the textarea, in rows. Defaults to 3. Also sets the
     * auto-grow ceiling unless `maxHeight` pins it explicitly.
     */
    rows?: number;
    /**
     * Ceiling (px) the auto-growing textarea stops at before it scrolls
     * internally. Defaults to whichever is taller: `rows`, or the old fixed
     * three-row height.
     */
    maxHeight?: number;
    submitting?: boolean;
    /** Placeholder examples to cycle through. Falls back to the single `placeholder`. */
    placeholderExamples?: ReadonlyArray<string>;
    placeholder?: string;
    /** Accessible label for the textarea. */
    ariaLabel: string;
    /**
     * Optional content rendered BELOW the composer card (outside the
     * card itself). Used by `/new` and `/works/new` to render the
     * generation-type chip strip beneath the prompt — matches the
     * website's landing layout.
     */
    chipsBelow?: ReactNode;
    /** Optional id for the textarea so an external <label> can point at it. */
    inputId?: string;
    /** Stable hook for tests / instrumentation. */
    testId?: string;
    /** Submit button tooltip. */
    submitTitle?: string;
    className?: string;
    /** Disable the input + submit entirely. */
    disabled?: boolean;
    /** Show the running character counter. Defaults to true. */
    showCounter?: boolean;
    /**
     * Show the "Import GitHub Repo" menu item in the (+) popover.
     * Only `/works/new` enables this — for other pages the GitHub
     * import affordance lives elsewhere.
     */
    showImportGithubRepo?: boolean;
    /**
     * Whether to render the (+) attachment button at all. Defaults to
     * true; set false on surfaces that don't want attachments. Also gates
     * drag-and-drop and paste-to-attach.
     */
    attachmentsEnabled?: boolean;
    /**
     * Fired whenever the local attachments list changes. Consumers
     * that want to persist or forward the attachments wire this up;
     * pages that only need the UI affordance can ignore it.
     */
    onAttachmentsChange?: (attachments: ReadonlyArray<ComposerAttachment>) => void;
}

export function PromptComposer({
    value,
    onChange,
    onSubmit,
    minLength = 10,
    maxLength = 5000,
    rows = 3,
    maxHeight,
    submitting = false,
    placeholderExamples,
    placeholder,
    ariaLabel,
    chipsBelow,
    inputId,
    testId,
    submitTitle,
    className,
    disabled = false,
    showCounter = true,
    showImportGithubRepo = false,
    attachmentsEnabled = true,
    onAttachmentsChange,
}: PromptComposerProps) {
    const [focused, setFocused] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const imageInputRef = useRef<HTMLInputElement | null>(null);
    const folderInputRef = useRef<HTMLInputElement | null>(null);
    const attachButtonRef = useRef<HTMLButtonElement | null>(null);
    const attachMenuRef = useRef<HTMLDivElement | null>(null);
    const githubInputRef = useRef<HTMLInputElement | null>(null);

    const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
    const [attachMenuOpen, setAttachMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
    const [githubFormOpen, setGithubFormOpen] = useState(false);
    const [githubUrl, setGithubUrl] = useState('');
    const [githubError, setGithubError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const [previewId, setPreviewId] = useState<string | null>(null);
    // Transient explanation for something we did to the user's pick (e.g.
    // truncating a very large dropped folder). Cleared on the next intake.
    const [notice, setNotice] = useState<string | null>(null);

    const trimmed = value.trim();
    // The textarea's native `maxLength={maxLength}` caps the raw value
    // before we ever see it, so no `tooLong` guard is needed here —
    // trimming can only shorten the string, never grow it past the cap.
    const canSubmit = !disabled && !submitting && trimmed.length >= minLength;
    const inputDisabled = disabled || submitting;

    const examples =
        placeholderExamples && placeholderExamples.length > 0 ? placeholderExamples : [];
    const typed = useTypewriterPlaceholder(focused || value.length > 0, examples, placeholder);
    const effectivePlaceholder = examples.length > 0 ? typed : placeholder || '';

    /* ---------------------------------------------------------------- */
    /* Dictation                                                        */
    /* ---------------------------------------------------------------- */

    // Everything this dictation session appended, so "discard" can put the
    // prompt back exactly as it was instead of clearing the whole field.
    const dictatedRef = useRef('');

    const appendDictated = useCallback(
        (text: string) => {
            const separator = value.length > 0 && !/\s$/.test(value) ? ' ' : '';
            const next = `${value}${separator}${text}`.slice(0, maxLength);
            // Slice off what actually landed — the cap may have truncated it.
            dictatedRef.current += next.slice(value.length);
            onChange(next);
        },
        [value, maxLength, onChange],
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
        // Only rewind when the tail is still verbatim ours; if the user
        // edited mid-dictation we leave their text alone rather than
        // guessing which part to cut.
        if (appended && value.endsWith(appended)) {
            onChange(value.slice(0, value.length - appended.length));
        }
        textareaRef.current?.focus();
    }, [dictation, onChange, value]);

    // A composer that goes disabled mid-sentence (submit in flight) must not
    // leave the mic open behind it.
    const { listening: dictating, stop: stopDictation } = dictation;
    useEffect(() => {
        if (inputDisabled && dictating) stopDictation();
    }, [inputDisabled, dictating, stopDictation]);

    // Starting dictation unmounts the mic button (the toolbar becomes the
    // VoiceBar), which would drop keyboard focus to <body>. Park it on the
    // textarea instead — the caret sits where the words are landing, and the
    // bar's discard / keep buttons are the next tab stops.
    useEffect(() => {
        if (dictating) textareaRef.current?.focus();
    }, [dictating]);

    /* ---------------------------------------------------------------- */
    /* Attachments                                                      */
    /* ---------------------------------------------------------------- */

    // Object URLs pin the underlying file in memory until revoked, so every
    // one we mint is tracked and released on removal / unmount.
    const objectUrlsRef = useRef<Set<string>>(new Set());
    useEffect(
        () => () => {
            objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
            objectUrlsRef.current.clear();
        },
        [],
    );

    const onAttachmentsChangeRef = useRef(onAttachmentsChange);
    useEffect(() => {
        onAttachmentsChangeRef.current = onAttachmentsChange;
    }, [onAttachmentsChange]);
    useEffect(() => {
        onAttachmentsChangeRef.current?.(attachments);
    }, [attachments]);

    const patchFile = useCallback((localId: string, changes: Partial<ComposerFileAttachment>) => {
        setAttachments((cur) =>
            cur.map((a) =>
                a.localId === localId && a.kind !== 'github-repo' ? { ...a, ...changes } : a,
            ),
        );
    }, []);

    const startUpload = useCallback(
        (file: File, localId: string) => {
            patchFile(localId, { uploading: true, progress: 0, error: undefined });
            void uploadFile(file, {
                onProgress: (percent) => patchFile(localId, { progress: percent }),
            })
                .then((res) => {
                    patchFile(localId, {
                        uploading: false,
                        progress: 100,
                        uploadId: res.id,
                        url: res.url,
                        mimeType: res.mimeType,
                    });
                })
                .catch((err: unknown) => {
                    const message =
                        err instanceof UploadError
                            ? err.message
                            : err instanceof Error
                              ? err.message
                              : 'Upload failed';
                    patchFile(localId, { uploading: false, progress: 0, error: message });
                });
        },
        [patchFile],
    );

    const ingestFiles = useCallback(
        (picked: ReadonlyArray<PickedFile>, kind: 'file' | 'folder-file') => {
            if (picked.length === 0) return;

            const next = picked.map(({ file, path }): ComposerFileAttachment => {
                const relPath =
                    path || (file as File & { webkitRelativePath?: string }).webkitRelativePath;
                const displayName = kind === 'folder-file' && relPath ? relPath : file.name;
                // Fail oversized files here rather than pushing 30 MB up the
                // wire just to have the API reject it.
                const tooLarge = file.size > MAX_UPLOAD_BYTES;

                let previewUrl: string | undefined;
                if (isImageFile(file)) {
                    try {
                        previewUrl = URL.createObjectURL(file);
                        objectUrlsRef.current.add(previewUrl);
                    } catch {
                        /* no preview — degrades to a file chip */
                    }
                }

                return {
                    kind,
                    localId: nextLocalId(kind),
                    file,
                    displayName,
                    progress: 0,
                    uploading: !tooLarge,
                    previewUrl,
                    error: tooLarge
                        ? `File is larger than ${formatBytes(MAX_UPLOAD_BYTES)}`
                        : undefined,
                };
            });

            setAttachments((cur) => [...cur, ...next]);

            // One XHR per file, in parallel. Each settles independently;
            // failures stay in `attachments` with an `error` so the user can
            // retry or dismiss them.
            for (const attachment of next) {
                if (!attachment.error) startUpload(attachment.file, attachment.localId);
            }
        },
        [startUpload],
    );

    const ingestPlainFiles = useCallback(
        (files: ReadonlyArray<File>) => {
            ingestFiles(
                files.map((file) => ({ file })),
                'file',
            );
        },
        [ingestFiles],
    );

    /**
     * Resolve a drop. A dropped *folder* arrives as a directory entry, not a
     * file: taking `dataTransfer.files` at face value would attach a 0-byte
     * stub named after the folder and then fail to upload it. So when any
     * entry is a directory we walk the tree and ingest its contents as folder
     * files, exactly like the folder picker does.
     */
    const ingestDrop = useCallback(
        async (entries: ReadonlyArray<DirectoryEntryLike>, flat: ReadonlyArray<File>) => {
            if (!entries.some((entry) => entry.isDirectory)) {
                ingestPlainFiles(flat);
                return;
            }

            const loose: PickedFile[] = [];
            const nested: PickedFile[] = [];
            for (const entry of entries) {
                if (entry.isDirectory) {
                    await walkEntry(entry, '', nested, MAX_DROPPED_FOLDER_FILES);
                } else {
                    const file = await fileOfEntry(entry);
                    if (file) loose.push({ file });
                }
            }

            if (loose.length > 0) ingestFiles(loose, 'file');
            if (nested.length > 0) ingestFiles(nested, 'folder-file');
            if (nested.length >= MAX_DROPPED_FOLDER_FILES) {
                setNotice(`Attached the first ${MAX_DROPPED_FOLDER_FILES} files from that folder.`);
            }
        },
        [ingestFiles, ingestPlainFiles],
    );

    const removeAttachment = useCallback(
        (localId: string) => {
            // Revoke outside the updater — state updaters must stay pure
            // (StrictMode runs them twice in development).
            const target = attachments.find((a) => a.localId === localId);
            if (target && target.kind !== 'github-repo' && target.previewUrl) {
                URL.revokeObjectURL(target.previewUrl);
                objectUrlsRef.current.delete(target.previewUrl);
            }
            setAttachments((cur) => cur.filter((a) => a.localId !== localId));
        },
        [attachments],
    );

    const retryAttachment = useCallback(
        (localId: string) => {
            const target = attachments.find((a) => a.localId === localId);
            if (!target || target.kind === 'github-repo') return;
            if (target.file.size > MAX_UPLOAD_BYTES) return;
            startUpload(target.file, localId);
        },
        [attachments, startUpload],
    );

    // Everything the overlay can render — images and readable text documents,
    // including files inside a picked folder.
    const previewable = useMemo(() => attachments.filter(isPreviewableAttachment), [attachments]);
    const previewIndex = previewId ? previewable.findIndex((a) => a.localId === previewId) : -1;

    // Announce upload progress for screen readers — the tiles and chips
    // carry this visually, but only visually.
    const status = useMemo(() => {
        const files = attachments.filter((a) => a.kind !== 'github-repo');
        const uploading = files.filter((a) => a.uploading).length;
        const failed = files.filter((a) => a.error).length;
        if (uploading > 0) return `Uploading ${uploading} file${uploading === 1 ? '' : 's'}`;
        if (failed > 0) return `${failed} upload${failed === 1 ? '' : 's'} failed`;
        if (files.length > 0)
            return `${files.length} file${files.length === 1 ? '' : 's'} attached`;
        return '';
    }, [attachments]);

    /* ---------------------------------------------------------------- */
    /* Slash commands (skill invocation slugs)                          */
    /* ---------------------------------------------------------------- */

    // Typing `/` as the FIRST token surfaces the user's invocation-slugged
    // skills (GET /api/skills/invocable through the cookie→Bearer proxy).
    // Selecting one completes the token; the server resolves it when the
    // message is submitted. Unknown `/foo` stays plain text. Shared with
    // the task-chat composer via the hook, so both surfaces offer the
    // same completions off one fetch.
    const slash = useSlashCommands({
        value,
        onChange,
        disabled: inputDisabled,
        inputRef: textareaRef,
    });

    /* ---------------------------------------------------------------- */
    /* Text input                                                       */
    /* ---------------------------------------------------------------- */

    // Without an explicit `maxHeight` the ceiling tracks `rows`, so a surface
    // that asked for a taller box keeps it instead of being clamped back to
    // the three-row default.
    const heightCeiling =
        maxHeight ??
        Math.max(MAX_TEXTAREA_HEIGHT, rows * TEXTAREA_LINE_HEIGHT + TEXTAREA_VERTICAL_PADDING);

    // Grow with the content up to the ceiling, then scroll internally, so a
    // short brief gets a compact box and a long one never pushes the card
    // past the height the fixed-row layout settled on.
    const autoGrow = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, heightCeiling)}px`;
        el.style.overflowY = el.scrollHeight > heightCeiling ? 'auto' : 'hidden';
    }, [heightCeiling]);

    useLayoutEffect(() => {
        autoGrow();
    }, [value, autoGrow]);

    function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
        // Slash-command popup owns the navigation keys while open.
        if (slash.handleKeyDown(e)) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (canSubmit) onSubmit();
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (canSubmit) onSubmit();
        }
    }

    function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
        if (!attachmentsEnabled || inputDisabled) return;
        const data = e.clipboardData;
        // A pasted screenshot carries files and no text/plain. Rich text
        // copied from a page can carry both — that should paste as text.
        if (Array.from(data?.types ?? []).includes('text/plain')) return;
        const files = filesFrom(data);
        if (files.length === 0) return;
        e.preventDefault();
        setNotice(null);
        ingestPlainFiles(files);
    }

    /* ---------------------------------------------------------------- */
    /* Drag and drop                                                    */
    /* ---------------------------------------------------------------- */

    // Dragging over a child fires dragleave on the parent, so count enters
    // and exits instead of toggling on the first leave.
    const dragDepthRef = useRef(0);
    const dropEnabled = attachmentsEnabled && !inputDisabled;

    function dragHasFiles(e: DragEvent<HTMLDivElement>) {
        return Array.from(e.dataTransfer?.types ?? []).includes('Files');
    }

    function onDragEnter(e: DragEvent<HTMLDivElement>) {
        if (!dropEnabled || !dragHasFiles(e)) return;
        dragDepthRef.current += 1;
        setDragging(true);
    }
    function onDragOver(e: DragEvent<HTMLDivElement>) {
        if (!dropEnabled || !dragHasFiles(e)) return;
        // Without preventDefault the browser navigates to the file on drop.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }
    function onDragLeave() {
        if (!dropEnabled) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
    }
    function onDrop(e: DragEvent<HTMLDivElement>) {
        if (!dropEnabled) return;
        dragDepthRef.current = 0;
        setDragging(false);
        // Both reads have to happen before the handler yields: the entry list
        // and `dataTransfer.files` are both cleared once the event completes.
        const entries = entriesFrom(e.dataTransfer);
        const files = filesFrom(e.dataTransfer);
        // Neither means someone dragged *text* in — let the textarea handle
        // that natively instead of swallowing the drop.
        if (entries.length === 0 && files.length === 0) return;
        e.preventDefault();
        setNotice(null);
        void ingestDrop(entries, files);
    }

    /* ---------------------------------------------------------------- */
    /* Attach menu                                                      */
    /* ---------------------------------------------------------------- */

    const closeAttachMenu = useCallback((restoreFocus = false) => {
        setGithubFormOpen(false);
        setAttachMenuOpen(false);
        if (restoreFocus) attachButtonRef.current?.focus();
    }, []);

    // Escape closes the popover (and the github sub-form).
    useEffect(() => {
        if (!attachMenuOpen) return;
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') closeAttachMenu(true);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [attachMenuOpen, closeAttachMenu]);

    // The menu only ever opens from a click, so `document` is guaranteed by
    // then; this guard is just for the server render of the closed state.
    const canPortal = typeof document !== 'undefined';

    const openAttachMenu = useCallback(() => {
        setGithubFormOpen(false);
        const button = attachButtonRef.current;
        if (button) setMenuPosition(measureMenuPosition(button));
        setAttachMenuOpen(true);
    }, []);

    // The portaled menu is anchored to a point in the viewport, so it has to
    // follow the button when the page moves under it. Scroll is captured so
    // nested scrollers count too; either event just re-measures.
    useEffect(() => {
        if (!attachMenuOpen) return;
        const reposition = () => {
            const button = attachButtonRef.current;
            if (button) setMenuPosition(measureMenuPosition(button));
        };
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [attachMenuOpen]);

    // Document-level mousedown listener to close the popover on outside
    // click. The composer card uses backdrop-blur which creates a
    // containing block for `position: fixed`, so a `<div className="fixed inset-0">`
    // backdrop would be clipped to the card. Ref-guarded so clicks inside
    // the popover (or on the (+) button itself) don't fire the close.
    useEffect(() => {
        if (!attachMenuOpen) return;
        const onDocMouseDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (!target) return;
            if (attachMenuRef.current?.contains(target)) return;
            if (attachButtonRef.current?.contains(target)) return;
            closeAttachMenu();
        };
        document.addEventListener('mousedown', onDocMouseDown);
        return () => document.removeEventListener('mousedown', onDocMouseDown);
    }, [attachMenuOpen, closeAttachMenu]);

    useEffect(() => {
        if (githubFormOpen) githubInputRef.current?.focus();
    }, [githubFormOpen]);

    // Land focus on the first item so the menu is usable from the keyboard
    // the moment it opens.
    useEffect(() => {
        if (!attachMenuOpen || githubFormOpen) return;
        attachMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [attachMenuOpen, githubFormOpen]);

    function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const items = Array.from(
            attachMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
        );
        if (items.length === 0) return;
        e.preventDefault();
        const active = items.indexOf(document.activeElement as HTMLElement);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        items[(active + delta + items.length) % items.length].focus();
    }

    function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
        const picked = e.target.files;
        setNotice(null);
        if (picked) ingestPlainFiles(Array.from(picked));
        // Reset so picking the same file twice still fires a change.
        e.target.value = '';
    }

    function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
        const picked = e.target.files;
        setNotice(null);
        if (picked) {
            ingestFiles(
                Array.from(picked).map((file) => ({ file })),
                'folder-file',
            );
        }
        e.target.value = '';
    }

    function onClickImages() {
        closeAttachMenu();
        imageInputRef.current?.click();
    }
    function onClickFile() {
        closeAttachMenu();
        fileInputRef.current?.click();
    }
    function onClickFolder() {
        closeAttachMenu();
        folderInputRef.current?.click();
    }
    function onClickGithub() {
        // Reveal the sub-form inside the popover (rather than opening a
        // separate URL) — the dashboard already has the user authenticated,
        // so we just need a repo URL to forward into the import flow.
        setGithubFormOpen(true);
    }
    function onAddGithub() {
        const url = githubUrl.trim();
        const match = url.match(GITHUB_REPO_RE);
        if (!match) {
            setGithubError('Enter a URL like https://github.com/owner/repo');
            return;
        }
        const owner = match[1];
        const repoRaw = match[2].replace(/\.git$/i, '');
        const displayName = `${owner}/${repoRaw}`;
        const canonical = `https://github.com/${owner}/${repoRaw}`;
        setAttachments((cur) => [
            ...cur,
            {
                kind: 'github-repo',
                localId: nextLocalId('gh'),
                url: canonical,
                displayName,
            },
        ]);
        closeAttachMenu();
        setGithubUrl('');
        setGithubError(null);
    }
    function onCancelGithub() {
        setGithubFormOpen(false);
        setGithubUrl('');
        setGithubError(null);
    }

    const attachMenuActions: Record<AttachMenuItemId, () => void> = {
        image: onClickImages,
        file: onClickFile,
        folder: onClickFolder,
        github: onClickGithub,
    };

    // Menu rows are padded buttons with their own rounding inside a padded
    // popover, so hover reads as a contained pill rather than a full-bleed
    // band — and at 13px the labels sit under the prompt text instead of
    // competing with it.
    const menuItemClass = cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px]',
        'text-text transition-colors dark:text-text-dark',
        'hover:bg-foreground/[0.06] focus:bg-foreground/[0.06] focus:outline-none',
        'dark:hover:bg-white/[0.06] dark:focus:bg-white/[0.06]',
    );
    const menuIconClass =
        'flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-text-secondary dark:bg-white/[0.06] dark:text-text-secondary-dark';
    const toolbarButtonClass = cn(
        'rounded-lg p-2 transition-colors',
        'text-text-muted dark:text-text-muted-dark',
        'hover:bg-foreground/[0.06] hover:text-text dark:hover:bg-white/[0.06] dark:hover:text-text-dark',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/40',
        'disabled:cursor-not-allowed disabled:opacity-40',
    );

    return (
        <div className={cn('relative w-full space-y-3', className)}>
            <SlashCommandPopup state={slash} />
            <div
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                data-dragging={dragging || undefined}
                className={cn(
                    'relative flex flex-col overflow-hidden rounded-2xl',
                    'border border-border/60 dark:border-white/10',
                    'bg-background dark:bg-zinc-900/50',
                    'shadow-sm',
                    'transition-[border-color,box-shadow,opacity] duration-200',
                    'focus-within:border-border-secondary focus-within:shadow-md',
                    'focus-within:ring-2 focus-within:ring-foreground/6',
                    'dark:focus-within:border-white/20',
                    dictating && 'border-border-secondary dark:border-white/20',
                    dragging &&
                        'border-border-secondary ring-2 ring-foreground/10 dark:border-white/25',
                    submitting && 'pointer-events-none opacity-60',
                )}
            >
                <textarea
                    ref={textareaRef}
                    id={inputId}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    placeholder={effectivePlaceholder}
                    maxLength={maxLength}
                    rows={rows}
                    disabled={inputDisabled}
                    aria-label={ariaLabel}
                    data-testid={testId}
                    className="block w-full resize-none bg-transparent px-4 pb-3 pt-4 text-base leading-relaxed text-text placeholder:text-text-muted/50 focus:outline-none dark:text-text-dark dark:placeholder:text-text-muted-dark/50"
                />

                <AttachmentStrip
                    attachments={attachments}
                    onRemove={removeAttachment}
                    onRetry={retryAttachment}
                    onPreview={setPreviewId}
                    testId={testId}
                />

                {notice ? (
                    <p
                        className="px-4 pb-2 text-[11px] text-text-muted dark:text-text-muted-dark"
                        data-testid={testId ? `${testId}-notice` : undefined}
                    >
                        {notice}
                    </p>
                ) : null}

                {dictating && dictation.startedAt !== null ? (
                    <VoiceBar
                        startedAt={dictation.startedAt}
                        canvasRef={dictation.canvasRef}
                        waveformActive={dictation.waveformActive}
                        onCancel={discardDictation}
                        onDone={finishDictation}
                        testId={testId}
                    />
                ) : (
                    <div className="flex items-center gap-0.5 border-t border-border/[0.15] px-2 pb-2.5 pt-1.5 dark:border-white/[0.06]">
                        {attachmentsEnabled ? (
                            <>
                                {/* Hidden pickers driven by the popover menu. */}
                                <input
                                    ref={imageInputRef}
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    className="hidden"
                                    onChange={onPickFiles}
                                    data-testid={testId ? `${testId}-image-input` : undefined}
                                />
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    multiple
                                    className="hidden"
                                    onChange={onPickFiles}
                                    data-testid={testId ? `${testId}-file-input` : undefined}
                                />
                                <input
                                    ref={folderInputRef}
                                    type="file"
                                    multiple
                                    className="hidden"
                                    onChange={onPickFolder}
                                    data-testid={testId ? `${testId}-folder-input` : undefined}
                                    // `webkitdirectory` lets the browser pick a folder
                                    // and surface every file in it. React 19 types
                                    // accept it as a string attribute; cast for older
                                    // types.
                                    {...({ webkitdirectory: '', directory: '' } as Record<
                                        string,
                                        string
                                    >)}
                                />

                                <div>
                                    <button
                                        ref={attachButtonRef}
                                        type="button"
                                        onClick={() => {
                                            if (attachMenuOpen) closeAttachMenu();
                                            else openAttachMenu();
                                        }}
                                        aria-label="Add attachment"
                                        title={
                                            showImportGithubRepo
                                                ? 'Add images, files, folders, or a GitHub repo'
                                                : 'Add images, files, or folders'
                                        }
                                        aria-haspopup="menu"
                                        aria-expanded={attachMenuOpen}
                                        disabled={inputDisabled}
                                        className={cn(
                                            toolbarButtonClass,
                                            attachMenuOpen &&
                                                'bg-foreground/[0.06] text-text dark:text-text-dark',
                                        )}
                                        data-testid={testId ? `${testId}-attach` : undefined}
                                    >
                                        <Plus
                                            className={cn(
                                                'size-4 transition-transform duration-200',
                                                attachMenuOpen && 'rotate-45',
                                            )}
                                            aria-hidden="true"
                                        />
                                    </button>

                                    {attachMenuOpen && menuPosition && canPortal
                                        ? createPortal(
                                              <div
                                                  ref={attachMenuRef}
                                                  role="menu"
                                                  aria-label="Attachment options"
                                                  onKeyDown={onMenuKeyDown}
                                                  data-testid={
                                                      testId ? `${testId}-attach-menu` : undefined
                                                  }
                                                  // Fixed to coordinates measured off the (+)
                                                  // button, in a portal at the document root:
                                                  // both the composer card and the pages
                                                  // around it clip their overflow, so an
                                                  // absolutely positioned menu was cut off at
                                                  // the card's edge.
                                                  style={{
                                                      position: 'fixed',
                                                      left: menuPosition.left,
                                                      top: menuPosition.top,
                                                      bottom: menuPosition.bottom,
                                                      width: MENU_WIDTH,
                                                  }}
                                                  className={cn(
                                                      'z-70 overflow-hidden rounded-2xl',
                                                      'border border-border/60 bg-background shadow-lg shadow-black/5',
                                                      'dark:border-white/10 dark:bg-zinc-900 dark:shadow-black/40',
                                                      'animate-in fade-in-0 zoom-in-95 duration-150',
                                                      menuPosition.bottom !== undefined
                                                          ? 'slide-in-from-bottom-1'
                                                          : 'slide-in-from-top-1',
                                                  )}
                                              >
                                                  {githubFormOpen ? (
                                                      <div className="flex flex-col gap-3 p-3">
                                                          <label
                                                              htmlFor={
                                                                  testId
                                                                      ? `${testId}-attach-github-input`
                                                                      : undefined
                                                              }
                                                              className="text-[11px] font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark"
                                                          >
                                                              GitHub repo URL
                                                          </label>
                                                          <input
                                                              ref={githubInputRef}
                                                              id={
                                                                  testId
                                                                      ? `${testId}-attach-github-input`
                                                                      : undefined
                                                              }
                                                              data-testid={
                                                                  testId
                                                                      ? `${testId}-attach-github-input`
                                                                      : undefined
                                                              }
                                                              type="url"
                                                              value={githubUrl}
                                                              onChange={(e) => {
                                                                  setGithubUrl(e.target.value);
                                                                  if (githubError)
                                                                      setGithubError(null);
                                                              }}
                                                              onKeyDown={(e) => {
                                                                  if (e.key === 'Enter') {
                                                                      e.preventDefault();
                                                                      onAddGithub();
                                                                  } else if (e.key === 'Escape') {
                                                                      e.preventDefault();
                                                                      onCancelGithub();
                                                                  }
                                                              }}
                                                              placeholder="https://github.com/owner/repo"
                                                              className="w-full rounded-lg border border-border/60 bg-foreground/[0.03] px-2.5 py-1.5 text-[13px] text-text transition-colors placeholder:text-text-muted/50 focus:border-border-secondary focus:outline-none focus:ring-1 focus:ring-foreground/10 dark:border-white/10 dark:bg-white/[0.03] dark:text-text-dark dark:placeholder:text-text-muted-dark/50 dark:focus:border-white/25"
                                                          />
                                                          {githubError ? (
                                                              <p
                                                                  role="alert"
                                                                  className="text-[11px] text-danger"
                                                              >
                                                                  {githubError}
                                                              </p>
                                                          ) : null}
                                                          <div className="flex items-center justify-end gap-2">
                                                              <button
                                                                  type="button"
                                                                  onClick={onCancelGithub}
                                                                  className="rounded-lg px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-foreground/[0.06] dark:text-text-muted-dark dark:hover:bg-white/[0.06]"
                                                              >
                                                                  Cancel
                                                              </button>
                                                              <button
                                                                  type="button"
                                                                  onClick={onAddGithub}
                                                                  data-testid={
                                                                      testId
                                                                          ? `${testId}-attach-github-add`
                                                                          : undefined
                                                                  }
                                                                  className="rounded-lg bg-button-primary px-2.5 py-1.5 text-xs font-medium text-button-primary-foreground transition-colors hover:bg-button-primary-hover dark:bg-button-primary-dark dark:text-button-primary-foreground-dark dark:hover:bg-button-primary-hover-dark"
                                                              >
                                                                  Add
                                                              </button>
                                                          </div>
                                                      </div>
                                                  ) : (
                                                      <ul className="flex flex-col gap-0.5 p-1.5">
                                                          {ATTACH_MENU_ITEMS.map((item) => {
                                                              if (
                                                                  item.id === 'github' &&
                                                                  !showImportGithubRepo
                                                              )
                                                                  return null;
                                                              const Icon = item.icon;
                                                              return (
                                                                  <li key={item.id}>
                                                                      <button
                                                                          type="button"
                                                                          role="menuitem"
                                                                          onClick={
                                                                              attachMenuActions[
                                                                                  item.id
                                                                              ]
                                                                          }
                                                                          data-testid={
                                                                              testId
                                                                                  ? `${testId}-attach-${item.id}`
                                                                                  : undefined
                                                                          }
                                                                          className={menuItemClass}
                                                                      >
                                                                          <span
                                                                              className={
                                                                                  menuIconClass
                                                                              }
                                                                              aria-hidden="true"
                                                                          >
                                                                              <Icon className="size-3.5" />
                                                                          </span>
                                                                          <span className="min-w-0 flex-1">
                                                                              <span className="block truncate">
                                                                                  {item.label}
                                                                              </span>
                                                                              <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                                                                                  {item.hint}
                                                                              </span>
                                                                          </span>
                                                                      </button>
                                                                  </li>
                                                              );
                                                          })}
                                                      </ul>
                                                  )}
                                              </div>,
                                              document.body,
                                          )
                                        : null}
                                </div>
                            </>
                        ) : null}

                        {dictation.supported ? (
                            <button
                                type="button"
                                onClick={startDictation}
                                aria-label="Start dictation"
                                title="Dictate your prompt"
                                disabled={inputDisabled}
                                className={toolbarButtonClass}
                                data-testid={testId ? `${testId}-mic` : undefined}
                            >
                                <Mic className="size-4" aria-hidden="true" />
                            </button>
                        ) : null}

                        <div className="ml-auto flex items-center gap-3">
                            {/* Counter stays out of the way until it's close to
                                mattering, or the user is actively typing. */}
                            {showCounter && (focused || trimmed.length > maxLength * 0.6) ? (
                                <span
                                    className={cn(
                                        'text-[11px] tabular-nums transition-colors',
                                        trimmed.length >= maxLength
                                            ? 'text-danger'
                                            : trimmed.length > maxLength * 0.9
                                              ? 'text-warning'
                                              : 'text-text-muted/60 dark:text-text-muted-dark/60',
                                    )}
                                >
                                    {trimmed.length}/{maxLength}
                                </span>
                            ) : null}
                            <button
                                type="button"
                                onClick={onSubmit}
                                disabled={!canSubmit}
                                title={submitTitle}
                                aria-label={submitTitle || ariaLabel}
                                data-testid={testId ? `${testId}-submit` : undefined}
                                className={cn(
                                    'inline-flex items-center justify-center rounded-full p-2.5',
                                    'transition-[transform,box-shadow,background-color,color] duration-150',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                                    canSubmit
                                        ? cn(
                                              'bg-button-primary text-button-primary-foreground shadow-sm',
                                              'dark:bg-button-primary-dark dark:text-button-primary-foreground-dark',
                                              'hover:bg-button-primary-hover hover:shadow-md',
                                              'dark:hover:bg-button-primary-hover-dark active:scale-95',
                                          )
                                        : // Neutral rather than a faded solid: a
                                          // ghosted action button reads as "broken",
                                          // a quiet one reads as "not yet".
                                          'cursor-not-allowed bg-foreground/[0.06] text-text-muted dark:bg-white/[0.06] dark:text-text-muted-dark',
                                )}
                            >
                                {submitting ? (
                                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                ) : (
                                    <ArrowUp className="size-4" aria-hidden="true" />
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {dragging ? (
                    <div
                        className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/85 backdrop-blur-sm dark:bg-zinc-900/85"
                        data-testid={testId ? `${testId}-dropzone` : undefined}
                    >
                        <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border-secondary px-8 py-5 dark:border-white/25">
                            <Paperclip
                                className="size-5 text-text-secondary dark:text-text-secondary-dark"
                                aria-hidden="true"
                            />
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                Drop files or a folder to attach
                            </p>
                        </div>
                    </div>
                ) : null}
            </div>

            <span aria-live="polite" className="sr-only">
                {[notice, status].filter(Boolean).join('. ')}
            </span>

            {previewIndex >= 0 ? (
                <AttachmentPreview
                    attachments={previewable}
                    index={previewIndex}
                    onIndexChange={(next) => setPreviewId(previewable[next]?.localId ?? null)}
                    onClose={() => setPreviewId(null)}
                    testId={testId}
                />
            ) : null}

            {chipsBelow ? <div>{chipsBelow}</div> : null}
        </div>
    );
}

// Re-export the attachment shapes + ref helper so existing consumers keep
// importing them from this module.
export { buildAttachmentRefs };
export type { ComposerAttachment, ComposerAttachmentRef };
