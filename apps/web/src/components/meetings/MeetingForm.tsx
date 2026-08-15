'use client';

import { useState, useTransition } from 'react';
import { ChevronLeft, Folder, Video } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import {
    MEETING_CREATABLE_SOURCES,
    MEETING_EXTERNAL_ID_MAX_CHARS,
    MEETING_SOURCE_URL_MAX_CHARS,
    MEETING_TITLE_MAX_CHARS,
    MEETING_TRANSCRIPT_MAX_CHARS,
    type MeetingSource,
} from '@/lib/api/meetings.shared';
import type { MeetingWorkOption } from './MeetingsList';
import { localInputToIso, sourceIconMap } from './meeting-ui';
import {
    MeetingParticipantsEditor,
    participantsFromRows,
    type ParticipantRow,
} from './MeetingParticipantsEditor';
import { createMeetingAction } from './actions';

/** Stable across renders — the marks never depend on form state. */
const SOURCE_ICONS = sourceIconMap(MEETING_CREATABLE_SOURCES);

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4';

const fieldLabel = 'block text-xs font-medium text-text dark:text-text-dark mb-2';

// `text-xs` throughout, matching the detail page's edit dialog: one type
// size across every control (Inputs, both pickers at `size="xs"`, the two
// textareas) rather than `text-sm` fields above `text-xs` textareas.
const dateInput = cn(
    'w-full text-xs rounded-lg transition-colors outline-none px-4 py-2',
    'bg-card dark:bg-card-primary-dark',
    'border border-card-border dark:border-white/9',
    'text-text dark:text-text-dark',
    'focus:border-primary dark:focus:border-white/9 focus:ring-2 focus:ring-primary-800/20',
);

/**
 * Meetings — capture form backing `/meetings/new`.
 *
 * Collects everything `POST /api/meetings` accepts: title, start/end,
 * producing source, the Work to route the meeting to (org-wide when
 * omitted), the recording deep link, the provider meeting id, a roster
 * and — optionally — the transcript itself. Supplying the transcript
 * here runs the SAME best-effort pipeline as attaching it later
 * (summary → Memory observation → `meeting.transcript` envelope), so
 * capture-and-summarize is a single round trip.
 *
 * Validation mirrors the API so obvious mistakes never cost a request;
 * the API re-validates everything regardless (it is the source of
 * truth).
 */
export function MeetingForm({ works = [] }: { works?: MeetingWorkOption[] }) {
    const t = useTranslations('dashboard.meetingNew');
    const router = useRouter();
    const [pending, startSubmit] = useTransition();

    const [title, setTitle] = useState('');
    const [startedAt, setStartedAt] = useState('');
    const [endedAt, setEndedAt] = useState('');
    const [source, setSource] = useState<MeetingSource>('manual');
    const [workId, setWorkId] = useState('');
    const [sourceUrl, setSourceUrl] = useState('');
    const [externalId, setExternalId] = useState('');
    const [participantRows, setParticipantRows] = useState<ParticipantRow[]>([]);
    const [transcriptText, setTranscriptText] = useState('');

    const submit = () => {
        const trimmedTitle = title.trim();
        if (trimmedTitle.length < 1) {
            toast.error(t('errors.titleRequired'));
            return;
        }

        // `startedAt` is REQUIRED by the API. An empty field means "now",
        // which is the honest default for a meeting you are capturing as
        // it happens — the field is pre-fillable for anything historical.
        const startedIso = startedAt ? localInputToIso(startedAt) : new Date().toISOString();
        if (!startedIso) {
            toast.error(t('errors.startedAtInvalid'));
            return;
        }

        let endedIso: string | undefined;
        if (endedAt) {
            const parsed = localInputToIso(endedAt);
            if (!parsed) {
                toast.error(t('errors.endedAtInvalid'));
                return;
            }
            if (Date.parse(parsed) < Date.parse(startedIso)) {
                toast.error(t('errors.endedBeforeStarted'));
                return;
            }
            endedIso = parsed;
        }

        // Malformed addresses are caught here rather than at the API, so the
        // message names the typo instead of surfacing a 400 — same guard the
        // detail page's edit dialog runs.
        const { participants, invalidEmail } = participantsFromRows(participantRows);
        if (invalidEmail) {
            toast.error(t('errors.participantEmailInvalid'));
            return;
        }

        const trimmedTranscript = transcriptText.trim();

        startSubmit(async () => {
            try {
                const meeting = await createMeetingAction({
                    title: trimmedTitle.slice(0, MEETING_TITLE_MAX_CHARS),
                    startedAt: startedIso,
                    ...(endedIso ? { endedAt: endedIso } : {}),
                    source,
                    ...(workId ? { workId } : {}),
                    ...(sourceUrl.trim()
                        ? { sourceUrl: sourceUrl.trim().slice(0, MEETING_SOURCE_URL_MAX_CHARS) }
                        : {}),
                    ...(externalId.trim()
                        ? { externalId: externalId.trim().slice(0, MEETING_EXTERNAL_ID_MAX_CHARS) }
                        : {}),
                    ...(participants.length > 0 ? { participants } : {}),
                    ...(trimmedTranscript
                        ? {
                              transcriptText: trimmedTranscript.slice(
                                  0,
                                  MEETING_TRANSCRIPT_MAX_CHARS,
                              ),
                          }
                        : {}),
                });
                toast.success(t('created'));
                router.push(`/meetings/${meeting.id}`);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('errors.createFailed'));
            }
        });
    };

    return (
        <div className="mx-auto w-full max-w-3xl space-y-6 p-6" data-testid="meeting-form">
            <div>
                <Link
                    href="/meetings"
                    className="inline-flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text dark:text-text-muted-dark dark:hover:text-text-dark"
                >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    {t('backToMeetings')}
                </Link>
                <div className="mt-3 flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-info/20 bg-info/10">
                        <Video className="h-5 w-5 text-info" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-semibold leading-tight text-text dark:text-text-dark">
                            {t('title')}
                        </h1>
                        <p className="mt-1 max-w-2xl text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('subtitle')}
                        </p>
                    </div>
                </div>
            </div>

            {/* Basics */}
            <section className={sectionCard}>
                <Input
                    label={t('fields.title')}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={MEETING_TITLE_MAX_CHARS}
                    placeholder={t('fields.titlePlaceholder')}
                    className="text-xs"
                />
                <div className="grid gap-4 @lg/main:grid-cols-2">
                    <div>
                        <label className={fieldLabel} htmlFor="meeting-started-at">
                            {t('fields.startedAt')}
                        </label>
                        <input
                            id="meeting-started-at"
                            data-testid="meeting-started-at"
                            type="datetime-local"
                            value={startedAt}
                            onChange={(e) => setStartedAt(e.target.value)}
                            className={dateInput}
                        />
                        <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                            {t('fields.startedAtHint')}
                        </p>
                    </div>
                    <div>
                        <label className={fieldLabel} htmlFor="meeting-ended-at">
                            {t('fields.endedAt')}
                        </label>
                        <input
                            id="meeting-ended-at"
                            data-testid="meeting-ended-at"
                            type="datetime-local"
                            value={endedAt}
                            onChange={(e) => setEndedAt(e.target.value)}
                            className={dateInput}
                        />
                    </div>
                </div>
            </section>

            {/* Provenance */}
            <section className={sectionCard}>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('sections.provenance')}
                </h2>
                <div className="grid gap-4 @lg/main:grid-cols-2">
                    <div>
                        <label className={fieldLabel}>{t('fields.source')}</label>
                        <Select
                            value={source}
                            onValueChange={(v) => setSource(v as MeetingSource)}
                            size="xs"
                            data-testid="meeting-source-select"
                            iconMap={SOURCE_ICONS}
                        >
                            {MEETING_CREATABLE_SOURCES.map((s) => (
                                <option key={s} value={s} data-icon={s}>
                                    {t(`sources.${s}`)}
                                </option>
                            ))}
                        </Select>
                    </div>
                    <div>
                        <label className={fieldLabel}>{t('fields.work')}</label>
                        {/* `data-icon` on every option (the org-wide row
                            included) keeps the folder in the trigger whatever
                            is selected, rather than letting it appear and
                            vanish with the choice — as on the edit dialog. */}
                        <Select
                            value={workId}
                            onValueChange={setWorkId}
                            placeholder={t('fields.workNone')}
                            size="xs"
                            data-testid="meeting-work-select"
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
                        <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                            {t('fields.workHint')}
                        </p>
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
                <Input
                    label={t('fields.externalId')}
                    value={externalId}
                    onChange={(e) => setExternalId(e.target.value)}
                    maxLength={MEETING_EXTERNAL_ID_MAX_CHARS}
                    helperText={t('fields.externalIdHint')}
                    className="text-xs"
                />
            </section>

            {/* Roster — rows, not `Name <email>` syntax in a textarea. The
                capture form was the last surface still teaching that format;
                it now authors the roster exactly the way the detail page's
                edit dialog does, so there is one way to name a participant.
                The editor carries its own label and count, so the section
                needs no heading of its own. */}
            <section className={sectionCard}>
                <MeetingParticipantsEditor
                    label={t('fields.participants')}
                    rows={participantRows}
                    onChange={setParticipantRows}
                    disabled={pending}
                />
            </section>

            {/* Transcript */}
            <section className={sectionCard}>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('sections.transcript')}
                </h2>
                <div>
                    <label className={fieldLabel} htmlFor="meeting-transcript">
                        {t('fields.transcript')}
                    </label>
                    <Textarea
                        id="meeting-transcript"
                        data-testid="meeting-transcript-input"
                        value={transcriptText}
                        onChange={(e) => setTranscriptText(e.target.value)}
                        rows={8}
                        maxLength={MEETING_TRANSCRIPT_MAX_CHARS}
                        placeholder={t('fields.transcriptPlaceholder')}
                        className="font-mono text-xs"
                    />
                    <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('fields.transcriptHint')}
                    </p>
                </div>
            </section>

            {/* Cancel then submit, secondary beside primary — the pairing the
                edit dialog's footer uses, so the two forms end the same way. */}
            <div className="flex items-center justify-end gap-2">
                <Button href="/meetings" variant="secondary" size="sm">
                    {t('actions.cancel')}
                </Button>
                <Button
                    onClick={submit}
                    loading={pending}
                    disabled={pending}
                    variant="primary"
                    size="sm"
                    data-testid="meeting-create-submit"
                >
                    {t('actions.create')}
                </Button>
            </div>
        </div>
    );
}
