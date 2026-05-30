'use client';

import { ArrowRight, File as FileIcon, Folder, Github, Loader2, Mic, Plus, X } from 'lucide-react';
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { cn } from '@/lib/utils/cn';
import { uploadFile, UploadError } from '@/lib/api/uploads';

/**
 * Shared prompt composer used by `/missions`, `/ideas`, `/new`, and
 * `/works/new`. Modeled on the website's `LandingPromptForm` (see
 * `Ever Works/Code/website/packages/web/components/global/
 * LandingPromptForm.tsx`) so the dashboard's prompt surfaces read
 * the same way visitors first met the product:
 *
 *   - Rounded card on the page's natural dark background (no nested
 *     `bg-card` wrapper).
 *   - Typewriter placeholder cycling through example briefs.
 *   - Bottom toolbar (single row): `+` attachment popover, mic
 *     dictation, character counter, arrow submit.
 *   - Optional attachment chip strip (file / folder / GitHub repo)
 *     rendered INSIDE the card, above the toolbar.
 *   - Optional `chipsBelow` slot for generation-type chip strips
 *     (rendered OUTSIDE / BELOW the card on the page) so the chip
 *     row visually mirrors the website.
 *   - Enter submits; Shift+Enter inserts a newline.
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

// Web Speech API isn't in TS's default DOM lib. Use a narrow ambient
// type just for the bits we touch; browsers expose it on
// `window.SpeechRecognition` (standard) or `window.webkitSpeechRecognition`
// (Chrome / Safari).
interface SpeechResult {
    readonly isFinal: boolean;
    readonly [index: number]: { readonly transcript: string };
}
interface SpeechResultList {
    readonly length: number;
    readonly [index: number]: SpeechResult;
}
interface SpeechEvent {
    readonly resultIndex: number;
    readonly results: SpeechResultList;
}
interface SpeechRecognizer {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: SpeechEvent) => void) | null;
    onend: (() => void) | null;
    onerror: (() => void) | null;
    start(): void;
    stop(): void;
}
type SpeechRecognizerCtor = new () => SpeechRecognizer;

declare global {
    interface Window {
        SpeechRecognition?: SpeechRecognizerCtor;
        webkitSpeechRecognition?: SpeechRecognizerCtor;
    }
}

/**
 * Hook: Web Speech API wrapper. Gracefully no-ops in browsers without
 * SpeechRecognition.
 */
function useSpeechRecognition(onResult: (text: string) => void) {
    const recognitionRef = useRef<SpeechRecognizer | null>(null);
    const [listening, setListening] = useState(false);
    const [supported, setSupported] = useState(false);

    // Park the latest callback in a ref so the recognizer can dispatch
    // through it without re-subscribing every render. See the website's
    // LandingPromptForm — re-subscribing would tear down continuous
    // dictation after the first phrase.
    const onResultRef = useRef(onResult);
    useEffect(() => {
        onResultRef.current = onResult;
    }, [onResult]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Ctor) {
            // `supported` defaults to false at mount — nothing to do here.
            // We deliberately avoid calling setSupported(false) in the effect
            // body to satisfy react-hooks/set-state-in-effect.
            return;
        }
        const rec = new Ctor();
        rec.continuous = true;
        rec.interimResults = false;
        rec.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
        rec.onresult = (event) => {
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) transcript += event.results[i][0].transcript;
            }
            if (transcript) onResultRef.current(transcript.trim());
        };
        rec.onend = () => setListening(false);
        rec.onerror = () => setListening(false);
        recognitionRef.current = rec;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot capability detection at mount; can't be derived during render (needs window.SpeechRecognition).
        setSupported(true);
        return () => {
            try {
                rec.stop();
            } catch {
                /* noop */
            }
        };
    }, []);

    const start = useCallback(() => {
        if (!recognitionRef.current) return;
        try {
            recognitionRef.current.start();
            setListening(true);
        } catch {
            /* already started */
        }
    }, []);
    const stop = useCallback(() => {
        try {
            recognitionRef.current?.stop();
        } catch {
            /* noop */
        }
        setListening(false);
    }, []);

    return { supported, listening, start, stop };
}

// Attachment shapes — discriminated union mirrors the website's
// LandingPromptForm. Each `file` / `folder-file` entry tracks its own
// upload state (progress / uploadId / url / error) so the chip strip
// can render distinct uploading / ready / error variants.
type ComposerAttachment =
    | {
          readonly kind: 'file' | 'folder-file';
          readonly localId: string;
          readonly file: File;
          readonly displayName: string;
          /** 0–100 percent — XHR-driven during upload. */
          progress: number;
          uploading: boolean;
          /**
           * Server-side upload id (sha256 of bytes) once the upload
           * completes. Callers persist this — it's the canonical
           * reference for `POST /api/me/missions/:id/attachments` etc.
           */
          uploadId?: string;
          /**
           * API-routed serve URL (`/api/uploads/<userId>/<filename>`)
           * once the upload completes. Forwarded into the chat prompt
           * so the chat AI can reference the file by URL.
           */
          url?: string;
          /** Server-declared MIME (echoed from backend response). */
          mimeType?: string;
          /** Human-readable failure message; chip flips to red. */
          error?: string;
      }
    | {
          readonly kind: 'github-repo';
          readonly localId: string;
          readonly url: string;
          readonly displayName: string;
      };

export interface PromptComposerProps {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    /** Min chars required for submit to be enabled. Defaults to 10. */
    minLength?: number;
    /** Hard cap enforced by the textarea. Defaults to 5000. */
    maxLength?: number;
    /** Number of rows in the textarea. Defaults to 3. */
    rows?: number;
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
     * true; set false on surfaces that don't want attachments.
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
    const folderInputRef = useRef<HTMLInputElement | null>(null);
    const attachButtonRef = useRef<HTMLButtonElement | null>(null);
    const attachMenuRef = useRef<HTMLDivElement | null>(null);
    const githubInputRef = useRef<HTMLInputElement | null>(null);

    const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
    const [attachMenuOpen, setAttachMenuOpen] = useState(false);
    const [githubFormOpen, setGithubFormOpen] = useState(false);
    const [githubUrl, setGithubUrl] = useState('');
    const [githubError, setGithubError] = useState<string | null>(null);

    const trimmed = value.trim();
    // The textarea's native `maxLength={maxLength}` caps the raw value
    // before we ever see it, so no `tooLong` guard is needed here —
    // trimming can only shorten the string, never grow it past the cap.
    const canSubmit = !disabled && !submitting && trimmed.length >= minLength;

    const examples =
        placeholderExamples && placeholderExamples.length > 0 ? placeholderExamples : [];
    const typed = useTypewriterPlaceholder(focused || value.length > 0, examples, placeholder);
    const effectivePlaceholder = examples.length > 0 ? typed : placeholder || '';

    const speech = useSpeechRecognition((text) =>
        onChange(value ? `${value} ${text}`.slice(0, maxLength) : text.slice(0, maxLength)),
    );

    // Surface attachment changes to consumers that wire this up.
    const onAttachmentsChangeRef = useRef(onAttachmentsChange);
    useEffect(() => {
        onAttachmentsChangeRef.current = onAttachmentsChange;
    }, [onAttachmentsChange]);
    useEffect(() => {
        onAttachmentsChangeRef.current?.(attachments);
    }, [attachments]);

    function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (canSubmit) onSubmit();
        }
    }

    // Escape closes the popover (and the github sub-form).
    useEffect(() => {
        if (!attachMenuOpen) return;
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') {
                setGithubFormOpen(false);
                setAttachMenuOpen(false);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
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
            setGithubFormOpen(false);
            setAttachMenuOpen(false);
        };
        document.addEventListener('mousedown', onDocMouseDown);
        return () => document.removeEventListener('mousedown', onDocMouseDown);
    }, [attachMenuOpen]);

    useEffect(() => {
        if (githubFormOpen) githubInputRef.current?.focus();
    }, [githubFormOpen]);

    const ingestFiles = useCallback((picked: FileList, kind: 'file' | 'folder-file') => {
        if (!picked || picked.length === 0) return;
        const next = Array.from(picked).map(
            (file): Extract<ComposerAttachment, { kind: 'file' | 'folder-file' }> => {
                const relPath =
                    (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
                const displayName = kind === 'folder-file' && relPath ? relPath : file.name;
                return {
                    kind,
                    localId: `${file.name}-${file.size}-${file.lastModified}-${Math.random()
                        .toString(36)
                        .slice(2, 6)}`,
                    file,
                    displayName,
                    progress: 0,
                    uploading: true,
                };
            },
        );
        setAttachments((cur) => [...cur, ...next]);

        // Fire one XHR upload per file in parallel. Each settles
        // independently; failures stay in `attachments` with an `error`
        // field so the user can see + retry / dismiss. The submit flow
        // can choose to wait for in-flight uploads or filter to
        // completed `uploadId`s — that's the caller's call.
        for (const attachment of next) {
            void uploadFile(attachment.file, {
                onProgress: (percent) => {
                    setAttachments((cur) =>
                        cur.map((a) =>
                            a.localId === attachment.localId &&
                            (a.kind === 'file' || a.kind === 'folder-file')
                                ? { ...a, progress: percent }
                                : a,
                        ),
                    );
                },
            })
                .then((res) => {
                    setAttachments((cur) =>
                        cur.map((a) =>
                            a.localId === attachment.localId &&
                            (a.kind === 'file' || a.kind === 'folder-file')
                                ? {
                                      ...a,
                                      uploading: false,
                                      progress: 100,
                                      uploadId: res.id,
                                      url: res.url,
                                      mimeType: res.mimeType,
                                  }
                                : a,
                        ),
                    );
                })
                .catch((err: unknown) => {
                    const message =
                        err instanceof UploadError
                            ? err.message
                            : err instanceof Error
                              ? err.message
                              : 'Upload failed';
                    setAttachments((cur) =>
                        cur.map((a) =>
                            a.localId === attachment.localId &&
                            (a.kind === 'file' || a.kind === 'folder-file')
                                ? { ...a, uploading: false, progress: 0, error: message }
                                : a,
                        ),
                    );
                });
        }
    }, []);

    function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
        const picked = e.target.files;
        if (picked) ingestFiles(picked, 'file');
        e.target.value = '';
    }

    function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
        const picked = e.target.files;
        if (picked) ingestFiles(picked, 'folder-file');
        e.target.value = '';
    }

    function removeAttachment(localId: string) {
        setAttachments((cur) => cur.filter((a) => a.localId !== localId));
    }

    function onClickFile() {
        setAttachMenuOpen(false);
        fileInputRef.current?.click();
    }
    function onClickFolder() {
        setAttachMenuOpen(false);
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
        const entry: ComposerAttachment = {
            kind: 'github-repo',
            localId: `gh-${owner}-${repoRaw}-${Math.random().toString(36).slice(2, 6)}`,
            url: canonical,
            displayName,
        };
        setAttachments((cur) => [...cur, entry]);
        setGithubFormOpen(false);
        setAttachMenuOpen(false);
        setGithubUrl('');
        setGithubError(null);
    }
    function onCancelGithub() {
        setGithubFormOpen(false);
        setGithubUrl('');
        setGithubError(null);
    }

    const inputDisabled = disabled || submitting;

    return (
        <div className={cn('w-full space-y-3', className)}>
            <div
                className={cn(
                    'relative flex flex-col rounded-2xl overflow-hidden',
                    'border border-border/60 dark:border-white/10',
                    'bg-background dark:bg-zinc-900/50',
                    'shadow-sm',
                    'transition-all duration-200',
                    'focus-within:border-border dark:focus-within:border-white/20',
                    submitting && 'opacity-60 pointer-events-none',
                )}
            >
                <textarea
                    ref={textareaRef}
                    id={inputId}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={onKeyDown}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    placeholder={effectivePlaceholder}
                    maxLength={maxLength}
                    rows={rows}
                    disabled={inputDisabled}
                    aria-label={ariaLabel}
                    data-testid={testId}
                    className="block w-full resize-none bg-transparent px-4 pt-4 pb-3 text-base leading-relaxed outline-none placeholder:text-text-muted/50 dark:placeholder:text-text-muted-dark/50 text-text dark:text-text-dark"
                />

                {attachments.length > 0 ? (
                    <div
                        className="flex flex-wrap gap-2 px-4 pb-2"
                        aria-label="Attached files"
                        data-testid={testId ? `${testId}-attachments` : undefined}
                    >
                        {attachments.map((a) => {
                            if (a.kind === 'github-repo') {
                                return (
                                    <div
                                        key={a.localId}
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 dark:border-white/10 bg-foreground/[0.04] dark:bg-white/[0.04] px-2.5 py-1 text-xs text-text dark:text-text-dark"
                                        title={a.url}
                                    >
                                        <Github
                                            className="size-3 text-text-muted dark:text-text-muted-dark"
                                            aria-hidden="true"
                                        />
                                        <span className="max-w-[12rem] truncate" title={a.url}>
                                            {a.displayName}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => removeAttachment(a.localId)}
                                            aria-label={`Remove ${a.displayName}`}
                                            className="ml-0.5 rounded p-0.5 text-text-muted dark:text-text-muted-dark hover:bg-foreground/10 hover:text-text dark:hover:text-text-dark transition-colors"
                                        >
                                            <X className="size-3" aria-hidden="true" />
                                        </button>
                                    </div>
                                );
                            }
                            // Three visual states:
                            //   uploading: spinner + "% N"
                            //   error: red ring + tooltip
                            //   ready: default
                            const variant = a.error
                                ? 'border-red-500/30 bg-red-500/[0.06] text-red-700 dark:text-red-300'
                                : a.uploading
                                  ? 'border-border/50 dark:border-white/10 bg-foreground/[0.04] dark:bg-white/[0.04] text-text-muted dark:text-text-muted-dark opacity-75'
                                  : 'border-border/50 dark:border-white/10 bg-foreground/[0.04] dark:bg-white/[0.04] text-text dark:text-text-dark';
                            const stateTag = a.error
                                ? 'error'
                                : a.uploading
                                  ? 'uploading'
                                  : 'ready';
                            return (
                                <div
                                    key={a.localId}
                                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${variant}`}
                                    title={a.error || a.displayName}
                                    data-testid={
                                        testId ? `${testId}-attachment-${stateTag}` : undefined
                                    }
                                >
                                    {a.uploading ? (
                                        <Loader2
                                            className="size-3 animate-spin text-text-muted dark:text-text-muted-dark"
                                            aria-hidden="true"
                                        />
                                    ) : a.kind === 'folder-file' ? (
                                        <Folder
                                            className="size-3 text-text-muted dark:text-text-muted-dark"
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <FileIcon
                                            className="size-3 text-text-muted dark:text-text-muted-dark"
                                            aria-hidden="true"
                                        />
                                    )}
                                    <span className="max-w-[12rem] truncate" title={a.displayName}>
                                        {a.displayName}
                                    </span>
                                    {a.uploading ? (
                                        <span
                                            className="text-[10px] tabular-nums text-text-muted dark:text-text-muted-dark"
                                            aria-label={`Uploading ${a.progress} percent`}
                                        >
                                            {a.progress}%
                                        </span>
                                    ) : null}
                                    {a.error ? (
                                        <span className="text-[10px] font-medium uppercase tracking-wider">
                                            failed
                                        </span>
                                    ) : null}
                                    <button
                                        type="button"
                                        onClick={() => removeAttachment(a.localId)}
                                        aria-label={`Remove ${a.displayName}`}
                                        className="ml-0.5 rounded p-0.5 text-text-muted dark:text-text-muted-dark hover:bg-foreground/10 hover:text-text dark:hover:text-text-dark transition-colors"
                                    >
                                        <X className="size-3" aria-hidden="true" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                ) : null}

                <div className="flex items-center gap-0.5 px-2 pb-2.5 pt-1.5 border-t border-border/[0.15] dark:border-white/[0.06]">
                    {attachmentsEnabled ? (
                        <>
                            {/* Hidden file pickers driven by the popover menu. */}
                            <input
                                ref={fileInputRef}
                                type="file"
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

                            <div className="relative">
                                <button
                                    ref={attachButtonRef}
                                    type="button"
                                    onClick={() => {
                                        setGithubFormOpen(false);
                                        setAttachMenuOpen((v) => !v);
                                    }}
                                    aria-label="Add attachment"
                                    title={
                                        showImportGithubRepo
                                            ? 'Add attachment (file, folder, or GitHub repo)'
                                            : 'Add attachment (file or folder)'
                                    }
                                    aria-haspopup="menu"
                                    aria-expanded={attachMenuOpen}
                                    disabled={inputDisabled}
                                    className={cn(
                                        'rounded-lg p-2 transition-colors',
                                        'text-text-muted dark:text-text-muted-dark',
                                        'hover:bg-foreground/[0.06] hover:text-text dark:hover:text-text-dark',
                                        'disabled:opacity-40 disabled:cursor-not-allowed',
                                        attachMenuOpen &&
                                            'bg-foreground/[0.06] text-text dark:text-text-dark',
                                    )}
                                    data-testid={testId ? `${testId}-attach` : undefined}
                                >
                                    <Plus className="size-4" aria-hidden="true" />
                                </button>

                                {attachMenuOpen ? (
                                    <div
                                        ref={attachMenuRef}
                                        role="menu"
                                        aria-label="Attachment options"
                                        data-testid={testId ? `${testId}-attach-menu` : undefined}
                                        // Positioned ABOVE the (+) button so the
                                        // menu stays visible without clipping —
                                        // page content below the composer is
                                        // typically dense.
                                        className="absolute bottom-full left-0 z-50 mb-2 min-w-[15rem] rounded-xl border border-border/60 dark:border-white/10 bg-background dark:bg-zinc-900 shadow-xl ring-1 ring-black/[0.04] dark:ring-white/[0.04] overflow-hidden"
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
                                                        if (githubError) setGithubError(null);
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
                                                    className="w-full rounded-lg border border-border/60 dark:border-white/10 bg-foreground/[0.03] dark:bg-white/[0.03] px-3 py-1.5 text-xs text-text dark:text-text-dark placeholder:text-text-muted/50 dark:placeholder:text-text-muted-dark/50 outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-colors"
                                                />
                                                {githubError ? (
                                                    <p
                                                        role="alert"
                                                        className="text-[11px] text-red-600 dark:text-red-400"
                                                    >
                                                        {githubError}
                                                    </p>
                                                ) : null}
                                                <div className="flex items-center justify-end gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={onCancelGithub}
                                                        className="rounded-lg px-3 py-1.5 text-xs text-text-muted dark:text-text-muted-dark hover:bg-foreground/[0.06] transition-colors"
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
                                                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 transition-colors"
                                                    >
                                                        Add
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <ul className="flex flex-col py-1.5">
                                                <li>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        onClick={onClickFile}
                                                        data-testid={
                                                            testId
                                                                ? `${testId}-attach-file`
                                                                : undefined
                                                        }
                                                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-text dark:text-text-dark hover:bg-foreground/[0.05] transition-colors"
                                                    >
                                                        <FileIcon
                                                            className="size-4 text-text-muted dark:text-text-muted-dark"
                                                            aria-hidden="true"
                                                        />
                                                        Upload a file
                                                    </button>
                                                </li>
                                                <li>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        onClick={onClickFolder}
                                                        data-testid={
                                                            testId
                                                                ? `${testId}-attach-folder`
                                                                : undefined
                                                        }
                                                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-text dark:text-text-dark hover:bg-foreground/[0.05] transition-colors"
                                                    >
                                                        <Folder
                                                            className="size-4 text-text-muted dark:text-text-muted-dark"
                                                            aria-hidden="true"
                                                        />
                                                        Upload a folder
                                                    </button>
                                                </li>
                                                {showImportGithubRepo ? (
                                                    <li>
                                                        <button
                                                            type="button"
                                                            role="menuitem"
                                                            onClick={onClickGithub}
                                                            data-testid={
                                                                testId
                                                                    ? `${testId}-attach-github`
                                                                    : undefined
                                                            }
                                                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-text dark:text-text-dark hover:bg-foreground/[0.05] transition-colors"
                                                        >
                                                            <Github
                                                                className="size-4 text-text-muted dark:text-text-muted-dark"
                                                                aria-hidden="true"
                                                            />
                                                            Import GitHub Repo
                                                        </button>
                                                    </li>
                                                ) : null}
                                            </ul>
                                        )}
                                    </div>
                                ) : null}
                            </div>
                        </>
                    ) : null}

                    {speech.supported ? (
                        <button
                            type="button"
                            onClick={() => (speech.listening ? speech.stop() : speech.start())}
                            aria-label={speech.listening ? 'Stop dictation' : 'Start dictation'}
                            title={speech.listening ? 'Stop dictation' : 'Dictate your prompt'}
                            aria-pressed={speech.listening}
                            disabled={inputDisabled}
                            className={cn(
                                'rounded-lg p-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                                speech.listening
                                    ? 'text-red-500 bg-red-500/10'
                                    : 'text-text-muted dark:text-text-muted-dark hover:bg-foreground/[0.06] hover:text-text dark:hover:text-text-dark',
                            )}
                            data-testid={testId ? `${testId}-mic` : undefined}
                        >
                            <Mic className="size-4" aria-hidden="true" />
                        </button>
                    ) : null}

                    <div className="ml-auto flex items-center gap-3">
                        {showCounter ? (
                            <span
                                className={cn(
                                    'text-[11px] tabular-nums transition-colors',
                                    trimmed.length > maxLength * 0.9
                                        ? 'text-amber-500 dark:text-amber-400'
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
                                'bg-primary text-white',
                                'shadow-sm hover:bg-primary/90 hover:shadow-md',
                                'active:scale-95',
                                'transition-all duration-150',
                                'disabled:cursor-not-allowed disabled:opacity-35',
                            )}
                        >
                            {submitting ? (
                                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            ) : (
                                <ArrowRight className="size-4" aria-hidden="true" />
                            )}
                        </button>
                    </div>
                </div>
            </div>

            {chipsBelow ? <div>{chipsBelow}</div> : null}
        </div>
    );
}

// Re-export the attachment shape so consumers wiring up
// `onAttachmentsChange` can type their state safely.
export type { ComposerAttachment };

/**
 * Helper for caller pages: turn the composer's full attachment list
 * into the lighter `{ name, url, mimeType?, kind }` shape that
 * `useStartFromPrompt` accepts. Uploads still in flight, uploads that
 * failed, and entries that don't yet have a server-side URL are
 * filtered out — only references the chat AI can actually act on are
 * forwarded.
 *
 * Returned tuple matches `StartFromPromptAttachmentRef` from
 * `use-start-from-prompt.tsx`; we don't import the type here to keep
 * this module free of upstream-hook dependencies, but consumers can
 * pass the return value straight into `startFromPrompt({ attachments })`.
 */
export interface ComposerAttachmentRef {
    readonly name: string;
    readonly url: string;
    readonly mimeType?: string;
    readonly kind: 'upload' | 'github-repo';
    /**
     * SHA-256 upload id — present only for `kind: 'upload'` refs that
     * have completed. Callers that wire the upload to a freshly-
     * created entity (Mission/Idea/Agent) pass this to
     * `addAttachment`. The chat-forwarder ignores this field.
     */
    readonly uploadId?: string;
}

export function buildAttachmentRefs(
    attachments: ReadonlyArray<ComposerAttachment>,
): ReadonlyArray<ComposerAttachmentRef> {
    const refs: ComposerAttachmentRef[] = [];
    for (const a of attachments) {
        if (a.kind === 'github-repo') {
            refs.push({ name: a.displayName, url: a.url, kind: 'github-repo' });
            continue;
        }
        if (a.url && a.uploadId && !a.uploading && !a.error) {
            refs.push({
                name: a.displayName,
                url: a.url,
                mimeType: a.mimeType,
                kind: 'upload',
                uploadId: a.uploadId,
            });
        }
    }
    return refs;
}
