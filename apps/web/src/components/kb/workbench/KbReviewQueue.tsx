'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { Archive, Check, ChevronDown, ChevronRight, Loader2, Pencil, Replace } from 'lucide-react';
import type { KbDocumentDto } from '@ever-works/contracts';
import {
    acceptKbDocumentAction,
    archiveKbDocumentAction,
    getKbDocumentBodyAction,
    listProposedKbDocumentsAction,
    listSupersedeCandidatesAction,
    supersedeKbDecisionAction,
} from '@/app/actions/works/kb-review';

/**
 * Memory upgrades M8 — the KB **review queue**.
 *
 * Agent-authored and consolidation-synthesized documents land as
 * `reviewState='proposed'` and are excluded from context injection until
 * a human accepts them (M7). Before this component that circuit breaker
 * had no UI: captured learning went into a state nothing surfaced, which
 * made the feature a discard rather than a review step.
 *
 * Every action here calls an endpoint that already existed:
 *   - **Accept**          → `POST …/documents/:docId/accept`
 *   - **Edit & accept**   → opens the existing workbench editor; the
 *                           `KbReviewBanner` on that page carries the
 *                           Accept button so the operator edits first and
 *                           accepts in place.
 *   - **Supersede**       → `POST …/documents/:docId/decision-status`
 *                           with `superseded` + the chosen survivor
 *                           (decision-class documents only — the status
 *                           machine is decision-scoped).
 *   - **Archive**         → `POST …/documents/:docId/archive`
 *
 * Content preview is lazy per row: the list endpoint is metadata-only, so
 * expanding a row fetches that one document's body.
 */

export interface KbReviewQueueProps {
    readonly workId: string;
    /**
     * Server-fetched first page. When omitted the component fetches on
     * mount — used by the unit specs and any future client-only mount.
     */
    readonly initialDocuments?: KbDocumentDto[];
    /** Server-side load error, rendered instead of an empty state. */
    readonly initialError?: string | null;
}

/** Chars of the body shown in an expanded preview. */
const PREVIEW_CHARS = 600;

type RowBusy = 'accept' | 'archive' | 'supersede' | null;

export function KbReviewQueue({
    workId,
    initialDocuments,
    initialError = null,
}: KbReviewQueueProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const router = useRouter();
    const [documents, setDocuments] = useState<KbDocumentDto[]>(initialDocuments ?? []);
    const [loading, setLoading] = useState(initialDocuments === undefined);
    const [error, setError] = useState<string | null>(initialError);

    const applyResult = useCallback(
        (result: Awaited<ReturnType<typeof listProposedKbDocumentsAction>>) => {
            if (result.success && result.data) {
                setDocuments(result.data.items ?? []);
                setError(null);
            } else {
                setError(result.error ?? 'Failed to load');
            }
            setLoading(false);
        },
        [],
    );

    /** Event-handler refresh (the error state's retry button). */
    const refresh = useCallback(async () => {
        setLoading(true);
        applyResult(await listProposedKbDocumentsAction(workId));
    }, [workId, applyResult]);

    useEffect(() => {
        // Client-only mount (no server-rendered first page). `loading` is
        // already seeded true from `initialDocuments === undefined`, and
        // every setState below happens AFTER the await — never
        // synchronously inside the effect body (react-hooks/set-state-in-effect).
        if (initialDocuments !== undefined) return;
        let cancelled = false;
        void (async () => {
            const result = await listProposedKbDocumentsAction(workId);
            if (cancelled) return;
            applyResult(result);
        })();
        return () => {
            cancelled = true;
        };
    }, [initialDocuments, workId, applyResult]);

    // Optimistic removal — an accepted / archived / superseded document is
    // no longer `proposed`, so it leaves the queue immediately instead of
    // waiting for a round-trip.
    const removeRow = useCallback(
        (docId: string) => {
            setDocuments((prev) => prev.filter((doc) => doc.id !== docId));
            try {
                router.refresh();
            } catch {
                /* the unit specs stub useRouter */
            }
        },
        [router],
    );

    if (loading) {
        return (
            <div
                data-testid="kb-review-queue-loading"
                className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-text-muted dark:text-text-muted-dark/70"
            >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('review.loading')}
            </div>
        );
    }

    if (error) {
        return (
            <div
                data-testid="kb-review-queue-error"
                role="alert"
                className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
            >
                <p className="text-sm text-danger">{error}</p>
                <button
                    type="button"
                    data-testid="kb-review-queue-retry"
                    onClick={() => void refresh()}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-card-hover dark:border-border-dark dark:hover:bg-card-primary-dark/40"
                >
                    {t('review.retry')}
                </button>
            </div>
        );
    }

    return (
        <div data-testid="kb-review-queue" className="flex h-full flex-col">
            <header className="flex items-center gap-2 border-b border-border px-4 py-3 dark:border-border-dark">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">
                    {t('review.title')}
                </h2>
                <span
                    data-testid="kb-review-queue-count"
                    className="rounded-full bg-card-hover px-2 py-0.5 text-[11px] font-medium text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/80"
                >
                    {documents.length}
                </span>
                <p className="ml-auto max-w-md text-right text-[11px] text-text-muted dark:text-text-muted-dark/60">
                    {t('review.subtitle')}
                </p>
            </header>

            {documents.length === 0 ? (
                <div
                    data-testid="kb-review-queue-empty"
                    className="flex flex-1 items-center justify-center p-8 text-center text-sm text-text-muted dark:text-text-muted-dark/70"
                >
                    <p className="max-w-md">{t('review.empty')}</p>
                </div>
            ) : (
                <ul className="flex-1 divide-y divide-border overflow-y-auto dark:divide-border-dark">
                    {documents.map((doc) => (
                        <KbReviewRow
                            key={doc.id}
                            workId={workId}
                            document={doc}
                            onResolved={() => removeRow(doc.id)}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}

interface KbReviewRowProps {
    readonly workId: string;
    readonly document: KbDocumentDto;
    readonly onResolved: () => void;
}

function KbReviewRow({ workId, document: doc, onResolved }: KbReviewRowProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const [expanded, setExpanded] = useState(false);
    const [preview, setPreview] = useState<string | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [busy, setBusy] = useState<RowBusy>(null);
    const [rowError, setRowError] = useState<string | null>(null);
    const [picking, setPicking] = useState(false);
    const [candidates, setCandidates] = useState<KbDocumentDto[] | null>(null);
    const [survivorId, setSurvivorId] = useState('');
    const [, startAction] = useTransition();

    const isDecision = doc.class === 'decision';
    const createdAt = useMemo(() => formatTimestamp(doc.createdAt), [doc.createdAt]);

    const toggleExpanded = useCallback(() => {
        const next = !expanded;
        setExpanded(next);
        if (!next || preview !== null || previewLoading) return;
        setPreviewLoading(true);
        void (async () => {
            const result = await getKbDocumentBodyAction(workId, doc.id);
            setPreview(
                result.success && result.data ? (result.data.body ?? '') : (result.error ?? ''),
            );
            setPreviewLoading(false);
        })();
    }, [expanded, preview, previewLoading, workId, doc.id]);

    const run = useCallback(
        (kind: Exclude<RowBusy, null>, fn: () => Promise<{ success: boolean; error?: string }>) => {
            setRowError(null);
            setBusy(kind);
            startAction(() => {
                void (async () => {
                    const result = await fn();
                    if (result.success) {
                        onResolved();
                        return;
                    }
                    setRowError(result.error ?? 'Action failed');
                    setBusy(null);
                })();
            });
        },
        [onResolved],
    );

    const openPicker = useCallback(() => {
        setPicking(true);
        setRowError(null);
        if (candidates !== null) return;
        void (async () => {
            const result = await listSupersedeCandidatesAction(workId, doc.id);
            if (result.success && result.data) {
                setCandidates(result.data);
            } else {
                setCandidates([]);
                setRowError(result.error ?? 'Failed to load decisions');
            }
        })();
    }, [candidates, workId, doc.id]);

    return (
        <li data-testid={`kb-review-row-${doc.id}`} data-kb-class={doc.class} className="px-4 py-3">
            <div className="flex items-start gap-2">
                <button
                    type="button"
                    onClick={toggleExpanded}
                    aria-expanded={expanded}
                    data-testid={`kb-review-row-${doc.id}-toggle`}
                    aria-label={t('review.preview')}
                    className="mt-0.5 rounded p-0.5 text-text-muted hover:bg-card-hover dark:hover:bg-card-primary-dark/40"
                >
                    {expanded ? (
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    )}
                </button>

                <div className="min-w-0 flex-1">
                    <Link
                        href={`${ROUTES.DASHBOARD_WORK_KB(workId)}/${doc.path}`}
                        data-testid={`kb-review-row-${doc.id}-title`}
                        className="block truncate text-sm font-medium text-text hover:underline dark:text-text-dark"
                    >
                        {doc.title || doc.path}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted dark:text-text-muted-dark/70">
                        <span
                            data-testid={`kb-review-row-${doc.id}-class`}
                            className="rounded-full bg-card-hover px-1.5 py-0.5 uppercase tracking-wide dark:bg-card-primary-dark/40"
                        >
                            {t(`classes.${doc.class}`)}
                        </span>
                        <span data-testid={`kb-review-row-${doc.id}-source`}>
                            {t('review.source', { source: doc.source })}
                        </span>
                        <span data-testid={`kb-review-row-${doc.id}-created`}>{createdAt}</span>
                    </div>
                    {doc.description ? (
                        <p className="mt-1 line-clamp-2 text-xs text-text-secondary dark:text-text-secondary-dark/80">
                            {doc.description}
                        </p>
                    ) : null}
                </div>

                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <RowAction
                        testId={`kb-review-row-${doc.id}-accept`}
                        label={t('review.accept')}
                        icon={Check}
                        busy={busy === 'accept'}
                        disabled={busy !== null}
                        onClick={() =>
                            run('accept', () =>
                                acceptKbDocumentAction({ workId, docId: doc.id, path: doc.path }),
                            )
                        }
                    />
                    <Link
                        href={`${ROUTES.DASHBOARD_WORK_KB(workId)}/${doc.path}`}
                        data-testid={`kb-review-row-${doc.id}-edit`}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-text-secondary hover:bg-card-hover dark:border-border-dark dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40"
                    >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        {t('review.editThenAccept')}
                    </Link>
                    {isDecision ? (
                        <RowAction
                            testId={`kb-review-row-${doc.id}-supersede`}
                            label={t('review.supersede')}
                            icon={Replace}
                            busy={busy === 'supersede'}
                            disabled={busy !== null}
                            onClick={openPicker}
                        />
                    ) : null}
                    <RowAction
                        testId={`kb-review-row-${doc.id}-archive`}
                        label={t('review.archive')}
                        icon={Archive}
                        busy={busy === 'archive'}
                        disabled={busy !== null}
                        onClick={() =>
                            run('archive', () =>
                                archiveKbDocumentAction({ workId, docId: doc.id, path: doc.path }),
                            )
                        }
                    />
                </div>
            </div>

            {picking ? (
                <div
                    data-testid={`kb-review-row-${doc.id}-supersede-picker`}
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card-hover/40 p-2 dark:border-border-dark dark:bg-card-primary-dark/30"
                >
                    <label
                        htmlFor={`kb-review-survivor-${doc.id}`}
                        className="text-[11px] text-text-muted dark:text-text-muted-dark/70"
                    >
                        {t('review.supersedePrompt')}
                    </label>
                    <select
                        id={`kb-review-survivor-${doc.id}`}
                        data-testid={`kb-review-row-${doc.id}-survivor-select`}
                        value={survivorId}
                        onChange={(e) => setSurvivorId(e.target.value)}
                        className="rounded border border-border bg-transparent px-2 py-1 text-xs dark:border-border-dark"
                    >
                        <option value="">{t('review.supersedePlaceholder')}</option>
                        {(candidates ?? []).map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                                {candidate.title || candidate.path}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        data-testid={`kb-review-row-${doc.id}-supersede-confirm`}
                        disabled={!survivorId || busy !== null}
                        onClick={() =>
                            run('supersede', () =>
                                supersedeKbDecisionAction({
                                    workId,
                                    docId: doc.id,
                                    supersededByDocId: survivorId,
                                    path: doc.path,
                                }),
                            )
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium disabled:opacity-50 dark:border-border-dark"
                    >
                        {t('review.supersedeConfirm')}
                    </button>
                    <button
                        type="button"
                        data-testid={`kb-review-row-${doc.id}-supersede-cancel`}
                        onClick={() => setPicking(false)}
                        className="rounded-md px-2 py-1 text-xs text-text-muted hover:bg-card-hover dark:hover:bg-card-primary-dark/40"
                    >
                        {t('review.cancel')}
                    </button>
                </div>
            ) : null}

            {expanded ? (
                <div
                    data-testid={`kb-review-row-${doc.id}-preview`}
                    className="mt-2 whitespace-pre-wrap rounded-md bg-card-hover/50 p-2 text-xs text-text-secondary dark:bg-card-primary-dark/30 dark:text-text-secondary-dark/80"
                >
                    {previewLoading
                        ? t('review.previewLoading')
                        : truncate(preview ?? '', PREVIEW_CHARS) || t('review.previewEmpty')}
                </div>
            ) : null}

            {rowError ? (
                <p
                    role="alert"
                    data-testid={`kb-review-row-${doc.id}-error`}
                    className="mt-2 text-xs text-danger"
                >
                    {rowError}
                </p>
            ) : null}
        </li>
    );
}

interface RowActionProps {
    readonly testId: string;
    readonly label: string;
    readonly icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onClick: () => void;
}

function RowAction({ testId, label, icon: Icon, busy, disabled, onClick }: RowActionProps) {
    return (
        <button
            type="button"
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium',
                'text-text-secondary hover:bg-card-hover disabled:opacity-50',
                'dark:border-border-dark dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40',
            )}
        >
            {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden={true} />
            ) : (
                <Icon className="h-3 w-3" aria-hidden={true} />
            )}
            {label}
        </button>
    );
}

/** Trim a body preview at a character budget without splitting mid-word. */
export function truncate(text: string, max: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= max) return trimmed;
    const cut = trimmed.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function formatTimestamp(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? '—'
        : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
