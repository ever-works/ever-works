'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils/cn';
import { updateKbDocumentAction } from '@/app/actions/works/kb-document';
import type { KbDocumentBodyDto, KbDocumentDto } from '@ever-works/contracts';

/**
 * EW-641 slice A — Markdown split-pane editor.
 *
 * Left column: a controlled textarea with the doc body.
 * Right column: a live `react-markdown` preview of the textarea value.
 *
 * Autosave runs on an 800ms debounce after typing stops. The save path
 * is the same shared `updateKbDocumentAction` server action the row 6
 * Tiptap editor uses, so we get cache revalidation + the wrapped
 * `ActionResult` envelope for free.
 *
 * Two error edge cases get an inline banner above the editor:
 *  - 409 (version mismatch / "edited elsewhere") — surfaces a
 *    `kb.workbench.conflict` banner with a Reload button that calls
 *    the caller-supplied `onReload` if provided, else `location.reload`.
 *  - 423 (locked) — surfaces a `kb.workbench.locked` banner. We don't
 *    auto-disable the textarea because the server is the source of
 *    truth for lock state and we want the operator to see the message
 *    instead of a silently read-only surface; the next save will fail
 *    the same way until lock is released.
 *
 * The action envelope is `{ success, error }`; the underlying
 * `kbAPI.updateDocument` throws `ApiResponseError` with `statusCode`
 * but that doesn't survive the action boundary, so we sniff for
 * `HTTP 409` / `HTTP 423` substrings in the error message — the
 * server-api `ApiResponseError.message` reliably embeds the status
 * code when the API returns one. This is good enough for slice A;
 * slice B will switch to a structured discriminated error envelope.
 */
export interface MarkdownEditorProps {
    workId: string;
    document: KbDocumentDto;
    /** Optional callback fired after a successful save. */
    onSaved?: (document: KbDocumentBodyDto) => void;
    /** Override for the 800ms debounce — tests set this to 0 for sync runs. */
    autosaveDebounceMs?: number;
    /** Optional reload handler when the conflict banner's Reload button is clicked. */
    onReload?: () => void;
    /** Initial body — defaults to `document` if it carries a `body` field. */
    initialBody?: string;
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
type ServerErrorKind = 'conflict' | 'locked' | 'generic';

const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 800;

export function MarkdownEditor({
    workId,
    document,
    onSaved,
    autosaveDebounceMs = DEFAULT_AUTOSAVE_DEBOUNCE_MS,
    onReload,
    initialBody,
}: MarkdownEditorProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const startBody = initialBody ?? (isBodyDto(document) ? document.body : '');
    const [body, setBody] = useState<string>(startBody);
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [errorKind, setErrorKind] = useState<ServerErrorKind | null>(null);
    const [savedAt, setSavedAt] = useState<number | null>(null);

    const lastSavedBodyRef = useRef<string>(startBody);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savingRef = useRef(false);
    const pendingBodyRef = useRef<string>(startBody);
    const docIdRef = useRef(document.id);

    // Reset state when the parent swaps to a different document.
    useEffect(() => {
        if (docIdRef.current === document.id) return;
        docIdRef.current = document.id;
        const next = initialBody ?? (isBodyDto(document) ? document.body : '');
        setBody(next);
        lastSavedBodyRef.current = next;
        pendingBodyRef.current = next;
        setStatus('idle');
        setErrorKind(null);
        setSavedAt(null);
    }, [document, initialBody]);

    const flush = useCallback(() => {
        if (savingRef.current) return;
        const candidate = pendingBodyRef.current;
        if (candidate === lastSavedBodyRef.current) {
            setStatus('idle');
            return;
        }

        savingRef.current = true;
        setStatus('saving');
        setErrorKind(null);

        void (async () => {
            const result = await updateKbDocumentAction({
                workId,
                docId: document.id,
                body: { body: candidate },
            });
            savingRef.current = false;

            if (result.success) {
                const confirmedBody = result.data?.body ?? candidate;
                lastSavedBodyRef.current = confirmedBody;
                setStatus('saved');
                setSavedAt(Date.now());
                if (result.data) onSaved?.(result.data);
                // If the user typed more during the save, schedule a
                // follow-up flush so the latest content actually lands.
                if (pendingBodyRef.current !== confirmedBody) {
                    armDebounce();
                }
            } else {
                const kind = classifyServerError(result.error);
                setErrorKind(kind);
                setStatus('error');
            }
        })();
    }, [workId, document.id, onSaved]);

    const armDebounce = useCallback(() => {
        if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
        }
        if (autosaveDebounceMs <= 0) {
            // Tests use 0 to run synchronously after a microtask.
            debounceRef.current = null;
            flush();
            return;
        }
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            flush();
        }, autosaveDebounceMs);
    }, [autosaveDebounceMs, flush]);

    useEffect(() => {
        return () => {
            if (debounceRef.current !== null) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        };
    }, []);

    const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const next = e.target.value;
        setBody(next);
        pendingBodyRef.current = next;
        if (!savingRef.current) {
            setStatus('dirty');
        }
        setErrorKind(null);
        armDebounce();
    };

    const reload = () => {
        if (onReload) {
            onReload();
            return;
        }
        if (typeof window !== 'undefined') {
            window.location.reload();
        }
    };

    return (
        <div
            data-testid="kb-workbench-editor"
            data-doc-id={document.id}
            data-status={status}
            className="flex h-full min-h-[24rem] flex-col"
        >
            <div className="flex items-center justify-end gap-2 px-4 py-1.5">
                <StatusIndicator
                    status={status}
                    savedAt={savedAt}
                    labels={{
                        saving: t('workbench.editor.saving'),
                        saved: t('workbench.editor.savedAt'),
                    }}
                />
            </div>

            {errorKind === 'conflict' ? (
                <Banner
                    testId="kb-workbench-conflict-banner"
                    tone="warning"
                    message={t('workbench.conflict')}
                    actionLabel={t('workbench.reload')}
                    onAction={reload}
                />
            ) : null}

            {errorKind === 'locked' ? (
                <Banner
                    testId="kb-workbench-locked-banner"
                    tone="warning"
                    message={t('workbench.locked')}
                />
            ) : null}

            <div className="grid flex-1 grid-cols-1 gap-0 md:grid-cols-2 md:divide-x md:divide-border md:dark:divide-border-dark">
                <div className="flex min-h-[16rem] flex-col">
                    <textarea
                        data-testid="kb-workbench-editor-textarea"
                        value={body}
                        onChange={onChange}
                        spellCheck
                        className={cn(
                            'h-full w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-relaxed',
                            'text-text outline-none dark:text-text-dark',
                            'focus:bg-card/70 dark:focus:bg-card-primary-dark/10',
                        )}
                        aria-label={t('panes.editor.title')}
                    />
                </div>
                <div className="flex min-h-[16rem] flex-col overflow-auto p-4">
                    <span
                        className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark/70"
                        data-testid="kb-workbench-editor-preview-label"
                    >
                        {t('workbench.editor.preview')}
                    </span>
                    <div
                        data-testid="kb-workbench-editor-preview"
                        className={cn('prose prose-sm max-w-none dark:prose-invert', 'flex-1')}
                    >
                        <ReactMarkdown remarkPlugins={remarkPlugins}>{body}</ReactMarkdown>
                    </div>
                </div>
            </div>
        </div>
    );
}

const remarkPlugins = [remarkGfm];

interface StatusIndicatorProps {
    status: SaveStatus;
    savedAt: number | null;
    labels: { saving: string; saved: string };
}

function StatusIndicator({ status, savedAt, labels }: StatusIndicatorProps) {
    const [, force] = useState(0);
    // Re-render once per second while we have a `savedAt` so the
    // "Saved 2s ago" copy stays fresh without flooding the React tree.
    useEffect(() => {
        if (savedAt === null) return;
        const interval = setInterval(() => force((v) => v + 1), 1000);
        return () => clearInterval(interval);
    }, [savedAt]);

    if (status === 'saving') {
        return (
            <span
                data-testid="kb-workbench-status"
                data-status="saving"
                className="text-xs text-text-muted dark:text-text-muted-dark/70"
            >
                {labels.saving}
            </span>
        );
    }
    if (status === 'saved' && savedAt !== null) {
        const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
        return (
            <span
                data-testid="kb-workbench-status"
                data-status="saved"
                className="text-xs text-emerald-700 dark:text-emerald-300"
            >
                {labels.saved.replace('{seconds}', String(seconds))}
            </span>
        );
    }
    return (
        <span data-testid="kb-workbench-status" data-status={status} className="sr-only">
            {status}
        </span>
    );
}

interface BannerProps {
    testId: string;
    tone: 'warning';
    message: string;
    actionLabel?: string;
    onAction?: () => void;
}

function Banner({ testId, tone: _tone, message, actionLabel, onAction }: BannerProps) {
    return (
        <div
            data-testid={testId}
            role="status"
            className={cn(
                'mx-4 mt-1 flex items-center gap-3 rounded-md border px-3 py-2 text-xs',
                'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
            )}
        >
            <span className="flex-1">{message}</span>
            {actionLabel && onAction ? (
                <button
                    type="button"
                    onClick={onAction}
                    data-testid={`${testId}-action`}
                    className={cn(
                        'rounded-md border border-amber-500/40 bg-white/40 px-2 py-1',
                        'text-amber-900 hover:bg-white/60',
                        'dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20',
                    )}
                >
                    {actionLabel}
                </button>
            ) : null}
        </div>
    );
}

function isBodyDto(document: KbDocumentDto | KbDocumentBodyDto): document is KbDocumentBodyDto {
    return typeof (document as KbDocumentBodyDto).body === 'string';
}

function classifyServerError(message: string | undefined): ServerErrorKind {
    if (!message) return 'generic';
    if (/(\b409\b|conflict|version mismatch)/i.test(message)) return 'conflict';
    if (/(\b423\b|locked)/i.test(message)) return 'locked';
    return 'generic';
}
