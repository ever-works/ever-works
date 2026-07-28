'use client';

import { useMemo, useState, useTransition } from 'react';
import {
    CalendarClock,
    ChevronLeft,
    ExternalLink,
    FileText,
    Save,
    Sparkles,
    Trash2,
    Upload,
    Users,
    Video,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
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
    formatDateTime,
    formatDuration,
    isoToLocalInput,
    localInputToIso,
} from './meeting-ui';
import { deleteMeetingAction, ingestMeetingTranscriptAction, updateMeetingAction } from './actions';

export interface MeetingDetailClientProps {
    meeting: Meeting;
    works?: MeetingWorkOption[];
}

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const btnDanger =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/30 dark:border-danger/20 text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

const fieldLabel = 'block text-xs font-medium text-text dark:text-text-dark mb-2';

const dateInput = cn(
    'w-full text-sm rounded-lg transition-colors outline-none px-4 py-2',
    'bg-card dark:bg-card-primary-dark',
    'border border-card-border dark:border-white/9',
    'text-text dark:text-text-dark',
    'focus:border-primary dark:focus:border-white/9 focus:ring-2 focus:ring-primary-800/20',
);

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="shrink-0 text-xs text-text-muted dark:text-text-muted-dark">
                {label}
            </span>
            <span className="min-w-0 truncate text-right text-xs font-medium text-text dark:text-text-dark">
                {children}
            </span>
        </div>
    );
}

/**
 * Meetings — `/meetings/:id` detail client.
 *
 * Renders the AI summary, the captured transcript, the roster and the
 * provenance rows, and hosts the three mutations the API supports for a
 * single meeting: attach/replace transcript, patch the editable fields,
 * and delete.
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

    const [title, setTitle] = useState(initial.title);
    const [sourceUrl, setSourceUrl] = useState(initial.sourceUrl ?? '');
    const [endedAt, setEndedAt] = useState(isoToLocalInput(initial.endedAt));
    const [workId, setWorkId] = useState(initial.workId ?? '');

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

    const saveDetails = () => {
        const trimmedTitle = title.trim();
        if (!trimmedTitle) {
            toast.error(t('errors.titleRequired'));
            return;
        }

        let endedIso: string | null = null;
        if (endedAt) {
            endedIso = localInputToIso(endedAt);
            if (!endedIso) {
                toast.error(t('errors.endedAtInvalid'));
                return;
            }
            if (Date.parse(endedIso) < Date.parse(meeting.startedAt)) {
                toast.error(t('errors.endedBeforeStarted'));
                return;
            }
        }

        startSave(async () => {
            try {
                const updated = await updateMeetingAction(meeting.id, {
                    title: trimmedTitle.slice(0, MEETING_TITLE_MAX_CHARS),
                    // `null` clears the field; on `workId` it re-routes the
                    // meeting back to org-wide. class-validator's
                    // @IsOptional() skips validation for an explicit null,
                    // and the service treats `!== undefined` as "patch it".
                    endedAt: endedIso,
                    workId: workId ? workId : null,
                    sourceUrl: sourceUrl.trim()
                        ? sourceUrl.trim().slice(0, MEETING_SOURCE_URL_MAX_CHARS)
                        : null,
                });
                setMeeting(updated);
                toast.success(t('toasts.saved'));
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.saveError'));
            }
        });
    };

    const handleDelete = () => {
        if (!window.confirm(t('confirm.delete'))) return;
        startDelete(async () => {
            try {
                await deleteMeetingAction(meeting.id);
                toast.success(t('toasts.deleted'));
                router.push('/meetings');
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.deleteError'));
            }
        });
    };

    return (
        <div className="mx-auto w-full max-w-screen-2xl space-y-6 p-6" data-testid="meeting-detail">
            {/* Header */}
            <div>
                <Link
                    href="/meetings"
                    className="inline-flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text dark:text-text-muted-dark dark:hover:text-text-dark"
                >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    {t('backToMeetings')}
                </Link>

                <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
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
                                <time dateTime={meeting.startedAt} suppressHydrationWarning>
                                    {formatDateTime(meeting.startedAt)}
                                </time>
                                <span aria-hidden="true">·</span>
                                <span>{formatDuration(minutes)}</span>
                            </p>
                        </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {meeting.sourceUrl ? (
                            <a
                                href={meeting.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={btn}
                                data-testid="meeting-recording-link"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                {t('actions.openRecording')}
                            </a>
                        ) : null}
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={pendingDelete}
                            className={btnDanger}
                            data-testid="meeting-delete"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t('actions.delete')}
                        </button>
                    </div>
                </div>
            </div>

            {/* Summary */}
            <section className={sectionCard} data-testid="meeting-summary">
                <div className="mb-4 flex items-center gap-2.5">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-info/20 bg-info/10">
                        <Sparkles className="h-3.5 w-3.5 text-info" />
                    </div>
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('sections.summary')}
                    </h2>
                </div>
                {meeting.summary ? (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-text dark:text-text-dark">
                        {meeting.summary}
                    </p>
                ) : (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {hasTranscript ? t('summary.notGenerated') : t('summary.noTranscript')}
                    </p>
                )}
            </section>

            {/* Transcript */}
            <section className={sectionCard} data-testid="meeting-transcript">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-info/20 bg-info/10">
                            <FileText className="h-3.5 w-3.5 text-info" />
                        </div>
                        <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('sections.transcript')}
                        </h2>
                    </div>
                    {hasTranscript ? (
                        <button
                            type="button"
                            onClick={() => setReplacing((v) => !v)}
                            className={btn}
                            data-testid="meeting-replace-transcript-toggle"
                        >
                            <Upload className="h-3.5 w-3.5" />
                            {replacing
                                ? t('actions.cancelReplace')
                                : t('actions.replaceTranscript')}
                        </button>
                    ) : null}
                </div>

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
                                <Upload className="h-3.5 w-3.5" />
                                {t('actions.attachTranscript')}
                            </button>
                            <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                {t('transcript.pipelineHint')}
                            </p>
                        </div>
                    </div>
                ) : null}
            </section>

            <div className="grid gap-5 @3xl/main:grid-cols-2">
                {/* Details */}
                <section className={sectionCard} data-testid="meeting-details">
                    <h2 className="mb-3 text-sm font-semibold text-text dark:text-text-dark">
                        {t('sections.details')}
                    </h2>
                    <div className="divide-y divide-border/50 dark:divide-border-dark/50">
                        <DetailRow label={t('details.source')}>
                            <SourceBadge source={meeting.source} />
                        </DetailRow>
                        <DetailRow label={t('details.startedAt')}>
                            <time dateTime={meeting.startedAt} suppressHydrationWarning>
                                {formatDateTime(meeting.startedAt)}
                            </time>
                        </DetailRow>
                        <DetailRow label={t('details.endedAt')}>
                            {meeting.endedAt ? (
                                <time dateTime={meeting.endedAt} suppressHydrationWarning>
                                    {formatDateTime(meeting.endedAt)}
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
                                    href={`/works/${meeting.workId}`}
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
                            <time dateTime={meeting.createdAt} suppressHydrationWarning>
                                {formatDateTime(meeting.createdAt)}
                            </time>
                        </DetailRow>
                    </div>

                    <div className="mt-4">
                        <div className="mb-2 flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                            <Users className="h-3 w-3 shrink-0" />
                            <span>{t('details.participants')}</span>
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
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('details.noParticipants')}
                            </p>
                        )}
                    </div>
                </section>

                {/* Edit */}
                <section className={sectionCard} data-testid="meeting-edit">
                    <h2 className="mb-1 text-sm font-semibold text-text dark:text-text-dark">
                        {t('sections.edit')}
                    </h2>
                    <p className="mb-3 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('edit.hint')}
                    </p>
                    <div className="space-y-4">
                        <Input
                            label={t('fields.title')}
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={MEETING_TITLE_MAX_CHARS}
                        />
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
                        <Input
                            label={t('fields.sourceUrl')}
                            value={sourceUrl}
                            onChange={(e) => setSourceUrl(e.target.value)}
                            maxLength={MEETING_SOURCE_URL_MAX_CHARS}
                            placeholder="https://example.com/recordings/123"
                        />
                        {works.length > 0 ? (
                            <div>
                                <label className={fieldLabel}>{t('fields.work')}</label>
                                <Select
                                    value={workId}
                                    onValueChange={setWorkId}
                                    placeholder={t('fields.workNone')}
                                    data-testid="meeting-edit-work"
                                >
                                    <option value="">{t('fields.workNone')}</option>
                                    {works.map((work) => (
                                        <option key={work.id} value={work.id}>
                                            {work.name}
                                        </option>
                                    ))}
                                </Select>
                            </div>
                        ) : null}
                        <button
                            type="button"
                            onClick={saveDetails}
                            disabled={pendingSave}
                            className={btn}
                            data-testid="meeting-save"
                        >
                            <Save className="h-3.5 w-3.5" />
                            {t('actions.save')}
                        </button>
                    </div>
                </section>
            </div>
        </div>
    );
}
