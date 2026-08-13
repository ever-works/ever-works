'use client';

import { useMemo, useState, useTransition } from 'react';
import {
    CalendarClock,
    ChevronLeft,
    ExternalLink,
    FileText,
    Folder,
    Info,
    Loader2,
    Pencil,
    Sparkles,
    Trash2,
    TriangleAlertIcon,
    Upload,
    Users,
    Video,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ShowDateTime } from '@/components/ui/show-datetime';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    MEETING_SOURCE_URL_MAX_CHARS,
    MEETING_TITLE_MAX_CHARS,
    MEETING_TRANSCRIPT_MAX_CHARS,
} from '@/lib/api/meetings.shared';
import type { Meeting } from '@/lib/api/meetings';
import type { MeetingWorkOption } from './MeetingsList';
import {
    SourceBadge,
    TranscriptBadge,
    durationMinutes,
    formatDuration,
    isoToLocalInput,
    localInputToIso,
} from './meeting-ui';
import {
    MeetingParticipantsEditor,
    participantRowsFrom,
    participantsFromRows,
    type ParticipantRow,
} from './MeetingParticipantsEditor';
import { MeetingSummaryGenerating } from './MeetingSummaryGenerating';
import { deleteMeetingAction, ingestMeetingTranscriptAction, updateMeetingAction } from './actions';

export interface MeetingDetailClientProps {
    meeting: Meeting;
    works?: MeetingWorkOption[];
}

// ─── Shared button classes ────────────────────────────────────────────────

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const btnDanger =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/30 dark:border-danger/20 text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

const fieldLabel = 'block text-xs font-medium text-text dark:text-text-dark mb-2';

// `text-xs` throughout the edit dialog's controls, matching the Work
// picker (Select `size="xs"`) and the roster textarea so every field in
// the form renders at one type size.
const dateInput = cn(
    'w-full text-xs rounded-lg transition-colors outline-none px-4 py-2',
    'bg-card dark:bg-card-primary-dark',
    'border border-card-border dark:border-white/9',
    'text-text dark:text-text-dark',
    'focus:border-primary dark:focus:border-white/9 focus:ring-2 focus:ring-primary-800/20',
);

// ─── Section header helper ────────────────────────────────────────────────

/**
 * Neutral icon-tile styling shared by every section header on this page,
 * lifted verbatim from `MissionDetailClient` so the two detail surfaces
 * read as one system.
 *
 * Every section here used to carry the same `info` accent as the entity
 * icon, which spent a semantic color on decoration and made four cards
 * compete with the one badge row that actually encodes state. The tile is
 * now design-system surface + border and the glyph secondary text; `info`
 * survives only on the entity tile (matching MeetingCard and the catalog
 * PageHeader), and `success`/neutral only on the source + transcript pills.
 */
const SECTION_ICON_TILE =
    'bg-surface-secondary dark:bg-surface-secondary-dark border-border/60 dark:border-border-dark/60';

const SECTION_ICON_GLYPH = 'text-text-secondary dark:text-text-secondary-dark';

function SectionHeader({
    icon: Icon,
    title,
    count,
    action,
    busy = false,
}: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    count?: number;
    action?: React.ReactNode;
    /**
     * Work is in flight for this section. The tile takes the `info` accent
     * and a breathing halo, so the section has ONE focal point for the
     * running state instead of a second spinner in the body.
     */
    busy?: boolean;
}) {
    return (
        <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
                <div className="relative shrink-0">
                    {busy ? (
                        <span
                            aria-hidden
                            className="ms-summary-halo pointer-events-none absolute -inset-1 rounded-lg bg-info/20"
                        />
                    ) : null}
                    <div
                        className={cn(
                            'relative flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
                            busy ? 'border-info/30 bg-info/10' : SECTION_ICON_TILE,
                        )}
                    >
                        <Icon
                            className={cn('h-3.5 w-3.5', busy ? 'text-info' : SECTION_ICON_GLYPH)}
                        />
                    </div>
                </div>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">{title}</h2>
            </div>
            {action ??
                (count !== undefined ? (
                    <span className="rounded-full border border-border bg-surface-secondary px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-muted dark:border-border-dark dark:bg-surface-secondary-dark dark:text-text-muted-dark">
                        {count}
                    </span>
                ) : null)}
        </div>
    );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="shrink-0 text-xs text-text-muted dark:text-text-muted-dark">
                {label}
            </span>
            {/* One step below the label: the value is the denser column
                (timestamps, ids, the source pill), and `text-[11px]`
                matches the chips it sits alongside. */}
            <span className="min-w-0 truncate text-right text-[11px] font-medium text-text dark:text-text-dark">
                {children}
            </span>
        </div>
    );
}

// ─── Component ───────────────────────────────────────────────────────────

/**
 * Meetings — `/meetings/:id` detail client.
 *
 * Renders the AI summary, the captured transcript, the roster and the
 * provenance rows, and hosts the three mutations the API supports for a
 * single meeting: attach/replace transcript, patch the editable fields,
 * and delete.
 *
 * Layout mirrors `MissionDetailClient`: every page-level action sits in a
 * single top bar on the breadcrumb line (destructive intent separated by a
 * divider), and the body splits into a content column (what the meeting
 * *says* — summary, transcript) beside a context rail (what it *is* — the
 * provenance rows and roster).
 *
 * Both mutations that change the record outright — Edit and Delete — are
 * dialogs behind that top bar, so the page itself reads as a record rather
 * than a form. Delete uses the same confirmation dialog the Mission and
 * Task detail pages use, rather than a blocking `window.confirm` the design
 * system cannot style, translate or test.
 *
 * The transcript panel is deliberately honest about the pipeline's
 * BEST-EFFORT half: the API stores the transcript and only then tries
 * the AI summary → Memory observation → ingest envelope. On a stack
 * with no AI provider the write still succeeds with no summary, so the
 * toast reports what actually happened instead of promising a summary
 * that never arrives.
 */
export function MeetingDetailClient({ meeting: initial, works = [] }: MeetingDetailClientProps) {
    const t = useTranslations('dashboard.meetingDetail');
    const router = useRouter();

    const [meeting, setMeeting] = useState<Meeting>(initial);
    const [pendingTranscript, startTranscript] = useTransition();
    const [pendingSave, startSave] = useTransition();
    const [pendingDelete, startDelete] = useTransition();

    const [transcriptDraft, setTranscriptDraft] = useState('');
    const [replacing, setReplacing] = useState(false);

    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [editOpen, setEditOpen] = useState(false);

    const [title, setTitle] = useState(initial.title);
    const [sourceUrl, setSourceUrl] = useState(initial.sourceUrl ?? '');
    const [startedAt, setStartedAt] = useState(isoToLocalInput(initial.startedAt));
    const [endedAt, setEndedAt] = useState(isoToLocalInput(initial.endedAt));
    const [workId, setWorkId] = useState(initial.workId ?? '');
    const [participantRows, setParticipantRows] = useState<ParticipantRow[]>(() =>
        participantRowsFrom(initial.participants ?? []),
    );

    const minutes = useMemo(
        () => durationMinutes(meeting.startedAt, meeting.endedAt),
        [meeting.startedAt, meeting.endedAt],
    );
    const transcript = meeting.transcriptText ?? '';
    const hasTranscript = meeting.hasTranscript || transcript.length > 0;
    const showComposer = !hasTranscript || replacing;

    const attachTranscript = () => {
        const text = transcriptDraft.trim();
        if (!text) {
            toast.error(t('errors.transcriptRequired'));
            return;
        }
        startTranscript(async () => {
            try {
                const result = await ingestMeetingTranscriptAction(
                    meeting.id,
                    text.slice(0, MEETING_TRANSCRIPT_MAX_CHARS),
                );
                setMeeting(result.meeting);
                setTranscriptDraft('');
                setReplacing(false);
                // Honest reporting: the summary leg is best-effort and is
                // simply absent on a stack with no AI provider.
                toast.success(
                    result.summary ? t('toasts.transcriptSummarized') : t('toasts.transcriptSaved'),
                );
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.transcriptError'));
            }
        });
    };

    /**
     * Re-seed every draft from the canonical row before showing the form, so
     * a cancelled edit is genuinely discarded rather than lingering as a
     * stale draft the next time the dialog opens.
     */
    const openEdit = () => {
        setTitle(meeting.title);
        setSourceUrl(meeting.sourceUrl ?? '');
        setStartedAt(isoToLocalInput(meeting.startedAt));
        setEndedAt(isoToLocalInput(meeting.endedAt));
        setWorkId(meeting.workId ?? '');
        setParticipantRows(participantRowsFrom(meeting.participants ?? []));
        setEditOpen(true);
    };

    const closeEdit = () => {
        if (pendingSave) return;
        setEditOpen(false);
    };

    const saveDetails = () => {
        const trimmedTitle = title.trim();
        if (!trimmedTitle) {
            toast.error(t('errors.titleRequired'));
            return;
        }

        // `startedAt` is REQUIRED by the API and is now editable here, so an
        // emptied or unparseable field is a local error rather than a 400.
        const startedIso = localInputToIso(startedAt);
        if (!startedIso) {
            toast.error(t('errors.startedAtInvalid'));
            return;
        }

        let endedIso: string | null = null;
        if (endedAt) {
            endedIso = localInputToIso(endedAt);
            if (!endedIso) {
                toast.error(t('errors.endedAtInvalid'));
                return;
            }
            // Compared against the DRAFT start, not the persisted one: both
            // ends move in a single save, so validating against the stored
            // value would reject a legitimate "shift the whole meeting" edit.
            if (Date.parse(endedIso) < Date.parse(startedIso)) {
                toast.error(t('errors.endedBeforeStarted'));
                return;
            }
        }

        // Malformed addresses are caught here rather than at the API, so
        // the message names the typo instead of surfacing a 400.
        const { participants, invalidEmail } = participantsFromRows(participantRows);
        if (invalidEmail) {
            toast.error(t('errors.participantEmailInvalid'));
            return;
        }

        startSave(async () => {
            try {
                const updated = await updateMeetingAction(meeting.id, {
                    title: trimmedTitle.slice(0, MEETING_TITLE_MAX_CHARS),
                    startedAt: startedIso,
                    // `null` clears the field; on `workId` it re-routes the
                    // meeting back to org-wide. class-validator's
                    // @IsOptional() skips validation for an explicit null,
                    // and the service treats `!== undefined` as "patch it".
                    endedAt: endedIso,
                    workId: workId ? workId : null,
                    sourceUrl: sourceUrl.trim()
                        ? sourceUrl.trim().slice(0, MEETING_SOURCE_URL_MAX_CHARS)
                        : null,
                    // An emptied roster posts `[]`, which is a real edit
                    // ("nobody recorded"), not a no-op.
                    participants,
                });
                setMeeting(updated);
                // Re-seed the drafts from the canonical row so the panel shows
                // what was actually stored (truncated titles, normalized
                // roster lines) rather than what was typed.
                setTitle(updated.title);
                setSourceUrl(updated.sourceUrl ?? '');
                setStartedAt(isoToLocalInput(updated.startedAt));
                setEndedAt(isoToLocalInput(updated.endedAt));
                setWorkId(updated.workId ?? '');
                setParticipantRows(participantRowsFrom(updated.participants ?? []));
                setEditOpen(false);
                toast.success(t('toasts.saved'));
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.saveError'));
            }
        });
    };

    const openDelete = () => {
        setDeleteError(null);
        setDeleteOpen(true);
    };

    const closeDelete = () => {
        if (pendingDelete) return;
        setDeleteOpen(false);
        setDeleteError(null);
    };

    const handleDelete = () => {
        setDeleteError(null);
        startDelete(async () => {
            try {
                await deleteMeetingAction(meeting.id);
                toast.success(t('toasts.deleted'));
                router.push(ROUTES.DASHBOARD_MEETINGS);
            } catch (err) {
                setDeleteError(err instanceof Error ? err.message : t('deleteDialog.error'));
            }
        });
    };

    return (
        <div className="mx-auto w-full max-w-screen-2xl space-y-6 p-6" data-testid="meeting-detail">
            {/* ── Header ───────────────────────────────────────────────────── */}
            <div>
                {/* Top bar — every page-level action lives here on the
                    breadcrumb line as a single non-wrapping row, with Delete
                    behind a divider so the destructive intent never reads as
                    part of the same group. The back link is the one element
                    that can truncate without losing meaning. */}
                <div className="flex items-center justify-between gap-3">
                    <Link
                        href={ROUTES.DASHBOARD_MEETINGS}
                        className="inline-flex min-w-0 items-center gap-1 text-xs text-text-muted transition-colors hover:text-text dark:text-text-muted-dark dark:hover:text-text-dark"
                    >
                        <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{t('backToMeetings')}</span>
                    </Link>

                    <div className="flex min-w-0 items-center gap-2 overflow-x-auto py-0.5">
                        {meeting.sourceUrl ? (
                            <a
                                href={meeting.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={cn(btn, 'shrink-0')}
                                data-testid="meeting-recording-link"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                {t('actions.openRecording')}
                            </a>
                        ) : null}
                        <button
                            type="button"
                            onClick={openEdit}
                            disabled={pendingSave}
                            className={cn(btn, 'shrink-0')}
                            data-testid="meeting-edit-open"
                        >
                            <Pencil className="h-3.5 w-3.5" />
                            {t('actions.edit')}
                        </button>
                        <span
                            aria-hidden
                            className="h-5 w-px shrink-0 bg-border dark:bg-border-dark"
                        />
                        <button
                            type="button"
                            onClick={openDelete}
                            disabled={pendingDelete}
                            className={cn(btnDanger, 'shrink-0')}
                            data-testid="meeting-delete"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t('actions.delete')}
                        </button>
                    </div>
                </div>

                {/* Icon + title + badges + when-it-happened line. */}
                <div className="mt-3 flex min-w-0 items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-info/20 bg-info/10">
                        <Video className="h-5 w-5 text-info" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-2xl font-semibold leading-tight text-text dark:text-text-dark">
                            {meeting.title}
                        </h1>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <SourceBadge source={meeting.source} />
                            <TranscriptBadge hasTranscript={hasTranscript} />
                        </div>
                        <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-sm text-text-secondary dark:text-text-secondary-dark">
                            <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                            <time dateTime={meeting.startedAt}>
                                <ShowDateTime value={meeting.startedAt} />
                            </time>
                            {minutes !== null ? (
                                <>
                                    <span aria-hidden="true">·</span>
                                    <span>{formatDuration(minutes)}</span>
                                </>
                            ) : null}
                        </p>
                    </div>
                </div>
            </div>

            {/* ── Body ─────────────────────────────────────────────────────
                Two tracks on wide viewports: the left column carries what the
                meeting *says* (its summary, then the transcript that produced
                it), the right rail carries what it *is* — provenance rows and
                the editable fields. Below @5xl the grid collapses to one
                column and the DOM order still reads content-first. */}
            <div className="grid items-start gap-5 @5xl/main:grid-cols-12">
                {/* ── Content column ───────────────────────────────────── */}
                <div className="min-w-0 space-y-5 @5xl/main:col-span-8">
                    {/* ── Summary ──────────────────────────────────────── */}
                    <section className={sectionCard} data-testid="meeting-summary">
                        <SectionHeader
                            icon={Sparkles}
                            title={t('sections.summary')}
                            busy={pendingTranscript}
                        />
                        {pendingTranscript ? (
                            <MeetingSummaryGenerating />
                        ) : meeting.summary ? (
                            // Keyed on the text so a freshly generated summary
                            // replays the reveal, resolving into the space the
                            // skeleton just held rather than snapping in.
                            <p
                                key={meeting.summary}
                                className="ms-summary-reveal whitespace-pre-wrap text-sm leading-relaxed text-text dark:text-text-dark"
                            >
                                {meeting.summary}
                            </p>
                        ) : (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {hasTranscript
                                    ? t('summary.notGenerated')
                                    : t('summary.noTranscript')}
                            </p>
                        )}
                    </section>

                    {/* ── Transcript ───────────────────────────────────── */}
                    <section className={sectionCard} data-testid="meeting-transcript">
                        <SectionHeader
                            icon={FileText}
                            title={t('sections.transcript')}
                            action={
                                hasTranscript ? (
                                    <button
                                        type="button"
                                        onClick={() => setReplacing((v) => !v)}
                                        className={cn(btn, 'shrink-0')}
                                        data-testid="meeting-replace-transcript-toggle"
                                    >
                                        <Upload className="h-3.5 w-3.5" />
                                        {replacing
                                            ? t('actions.cancelReplace')
                                            : t('actions.replaceTranscript')}
                                    </button>
                                ) : undefined
                            }
                        />

                        {hasTranscript ? (
                            <pre
                                data-testid="meeting-transcript-body"
                                className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-surface/40 p-4 font-mono text-xs leading-relaxed text-text dark:border-border-dark/50 dark:bg-surface-dark/30 dark:text-text-dark"
                            >
                                {transcript || t('transcript.storedElsewhere')}
                            </pre>
                        ) : null}

                        {showComposer ? (
                            <div className={hasTranscript ? 'mt-4' : ''}>
                                <label className={fieldLabel} htmlFor="meeting-transcript-draft">
                                    {t('transcript.composerLabel')}
                                </label>
                                <Textarea
                                    id="meeting-transcript-draft"
                                    data-testid="meeting-transcript-composer"
                                    value={transcriptDraft}
                                    onChange={(e) => setTranscriptDraft(e.target.value)}
                                    rows={8}
                                    maxLength={MEETING_TRANSCRIPT_MAX_CHARS}
                                    placeholder={t('transcript.composerPlaceholder')}
                                    // The text is already in flight; editing it
                                    // mid-request would only ever describe a
                                    // transcript the server never saw.
                                    disabled={pendingTranscript}
                                    className="font-mono text-xs"
                                />
                                <div className="mt-3 flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={attachTranscript}
                                        disabled={pendingTranscript}
                                        className={btn}
                                        data-testid="meeting-attach-transcript"
                                    >
                                        {pendingTranscript ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Upload className="h-3.5 w-3.5" />
                                        )}
                                        {pendingTranscript
                                            ? t('actions.attaching')
                                            : t('actions.attachTranscript')}
                                    </button>
                                    <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                        {t('transcript.pipelineHint')}
                                    </p>
                                </div>
                            </div>
                        ) : null}
                    </section>
                </div>

                {/* ── Context rail ─────────────────────────────────────── */}
                <aside className="min-w-0 space-y-5 @5xl/main:col-span-4">
                    {/* ── Details ──────────────────────────────────────── */}
                    <section className={sectionCard} data-testid="meeting-details">
                        <SectionHeader icon={Info} title={t('sections.details')} />
                        <div className="divide-y divide-border/50 dark:divide-border-dark/50">
                            <DetailRow label={t('details.source')}>
                                <SourceBadge source={meeting.source} />
                            </DetailRow>
                            <DetailRow label={t('details.startedAt')}>
                                <time dateTime={meeting.startedAt}>
                                    <ShowDateTime value={meeting.startedAt} />
                                </time>
                            </DetailRow>
                            <DetailRow label={t('details.endedAt')}>
                                {meeting.endedAt ? (
                                    <time dateTime={meeting.endedAt}>
                                        <ShowDateTime value={meeting.endedAt} />
                                    </time>
                                ) : (
                                    t('details.openEnded')
                                )}
                            </DetailRow>
                            <DetailRow label={t('details.duration')}>
                                {formatDuration(minutes)}
                            </DetailRow>
                            <DetailRow label={t('details.work')}>
                                {meeting.workId ? (
                                    <Link
                                        href={ROUTES.DASHBOARD_WORK(meeting.workId)}
                                        className="text-info hover:underline"
                                    >
                                        {works.find((w) => w.id === meeting.workId)?.name ??
                                            meeting.workId}
                                    </Link>
                                ) : (
                                    t('details.orgWide')
                                )}
                            </DetailRow>
                            <DetailRow label={t('details.externalId')}>
                                {meeting.externalId ?? '—'}
                            </DetailRow>
                            <DetailRow label={t('details.createdAt')}>
                                <time dateTime={meeting.createdAt}>
                                    <ShowDateTime value={meeting.createdAt} />
                                </time>
                            </DetailRow>
                        </div>

                        <div className="mt-4 border-t border-border/60 pt-4 dark:border-border-dark/60">
                            <div className="mb-2 flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                                <Users className="h-3 w-3 shrink-0" />
                                <span>{t('details.participants')}</span>
                                <span className="ml-auto rounded-full border border-border bg-surface-secondary px-2 py-0.5 text-[11px] font-medium tabular-nums dark:border-border-dark dark:bg-surface-secondary-dark">
                                    {meeting.participants.length}
                                </span>
                            </div>
                            {meeting.participants.length > 0 ? (
                                <ul className="space-y-1" data-testid="meeting-participants">
                                    {meeting.participants.map((p, i) => (
                                        <li
                                            key={`${p.name}-${p.email ?? ''}-${i}`}
                                            className="truncate text-xs text-text dark:text-text-dark"
                                        >
                                            {p.name}
                                            {p.email ? (
                                                <span className="text-text-muted dark:text-text-muted-dark">
                                                    {' '}
                                                    &lt;{p.email}&gt;
                                                </span>
                                            ) : null}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p
                                    className="text-xs text-text-muted dark:text-text-muted-dark"
                                    data-testid="meeting-participants"
                                >
                                    {t('details.noParticipants')}
                                </p>
                            )}
                        </div>
                    </section>
                </aside>
            </div>

            {/* ── Edit modal ───────────────────────────────────────────────
                The editable fields used to sit in a permanently-open card in
                the rail, which put a form the reader rarely needs directly
                beside the provenance rows they always read. It is now a
                dialog behind the header's Edit button, so the page reads as
                a record and editing is an explicit act. */}
            <Dialog open={editOpen} onOpenChange={(next) => (next ? openEdit() : closeEdit())}>
                <DialogContent className="max-w-lg">
                    <DialogClose onClose={closeEdit} />
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {t('sections.edit')}
                        </DialogTitle>
                        <DialogDescription className="text-xs">{t('edit.hint')}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4" data-testid="meeting-edit">
                        <Input
                            label={t('fields.title')}
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={MEETING_TITLE_MAX_CHARS}
                            className="text-xs"
                        />
                        {/* The two ends of the meeting are one fact, so they
                            sit on one row. Paired on the viewport breakpoint
                            rather than a container query: the dialog is
                            portalled out of the page's `main` container, so
                            an @lg/main step would never match here. */}
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label className={fieldLabel} htmlFor="meeting-edit-started-at">
                                    {t('fields.startedAt')}
                                </label>
                                <input
                                    id="meeting-edit-started-at"
                                    data-testid="meeting-edit-started-at"
                                    type="datetime-local"
                                    value={startedAt}
                                    onChange={(e) => setStartedAt(e.target.value)}
                                    className={dateInput}
                                />
                            </div>
                            <div>
                                <label className={fieldLabel} htmlFor="meeting-edit-ended-at">
                                    {t('fields.endedAt')}
                                </label>
                                <input
                                    id="meeting-edit-ended-at"
                                    data-testid="meeting-edit-ended-at"
                                    type="datetime-local"
                                    value={endedAt}
                                    onChange={(e) => setEndedAt(e.target.value)}
                                    className={dateInput}
                                />
                            </div>
                        </div>
                        <Input
                            label={t('fields.sourceUrl')}
                            value={sourceUrl}
                            onChange={(e) => setSourceUrl(e.target.value)}
                            maxLength={MEETING_SOURCE_URL_MAX_CHARS}
                            placeholder="https://example.com/recordings/123"
                            className="text-xs"
                        />
                        {works.length > 0 ? (
                            <div>
                                <label className={fieldLabel}>{t('fields.work')}</label>
                                {/* `data-icon` on every option (the org-wide
                                    row included) keeps the folder in the
                                    trigger whatever is selected, rather than
                                    letting it appear and vanish with the
                                    choice. */}
                                <Select
                                    value={workId}
                                    onValueChange={setWorkId}
                                    placeholder={t('fields.workNone')}
                                    size="xs"
                                    data-testid="meeting-edit-work"
                                    iconMap={{
                                        work: (
                                            <Folder className="h-3.5 w-3.5 text-text-muted dark:text-text-muted-dark" />
                                        ),
                                    }}
                                >
                                    <option value="" data-icon="work">
                                        {t('fields.workNone')}
                                    </option>
                                    {works.map((work) => (
                                        <option key={work.id} value={work.id} data-icon="work">
                                            {work.name}
                                        </option>
                                    ))}
                                </Select>
                            </div>
                        ) : null}
                        <MeetingParticipantsEditor
                            label={t('fields.participants')}
                            rows={participantRows}
                            onChange={setParticipantRows}
                            disabled={pendingSave}
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="meeting-edit-cancel"
                            disabled={pendingSave}
                            onClick={closeEdit}
                        >
                            {t('actions.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            data-testid="meeting-save"
                            loading={pendingSave}
                            onClick={saveDetails}
                        >
                            {t('actions.save')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Delete modal (mirrors the Mission detail delete dialog) ──── */}
            <Dialog
                open={deleteOpen}
                onOpenChange={(next) => (next ? setDeleteOpen(true) : closeDelete())}
            >
                <DialogContent className="max-w-md">
                    <DialogClose onClose={closeDelete} />
                    <DialogHeader className="mb-0">
                        <div className="mb-1 flex items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/50">
                                <TriangleAlertIcon className="size-4 text-red-600 dark:text-red-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {t('deleteDialog.title')}
                            </DialogTitle>
                        </div>
                        <DialogDescription>
                            {t('deleteDialog.body', { title: meeting.title })}
                        </DialogDescription>
                    </DialogHeader>

                    {deleteError ? (
                        <p
                            role="alert"
                            data-testid="meeting-delete-error"
                            className="mt-4 text-xs text-danger"
                        >
                            {deleteError}
                        </p>
                    ) : null}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="meeting-delete-cancel"
                            disabled={pendingDelete}
                            onClick={closeDelete}
                        >
                            {t('deleteDialog.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            data-testid="meeting-delete-confirm"
                            loading={pendingDelete}
                            onClick={handleDelete}
                        >
                            {pendingDelete ? t('deleteDialog.deleting') : t('deleteDialog.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
