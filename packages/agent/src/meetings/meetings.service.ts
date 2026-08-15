import { createHash, randomUUID } from 'crypto';
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { AiFacadeService } from '../facades/ai.facade';
import { AgentMemoryFacadeService } from '../facades/agent-memory.facade';
import { EventIngestService } from '../ingest/event-ingest.service';
import type { IngestedEvent } from '../entities/ingested-event.entity';
import { Meeting, MeetingParticipant, MeetingSource } from '../entities/meeting.entity';
import { FindMeetingsFilters, MeetingRepository } from './meeting.repository';

/**
 * Hard cap on a stored transcript (chars). The API edge enforces its
 * own request-size cap; this is the defensive service-level floor so
 * no path (connector processor included) can write unbounded text.
 */
export const MEETING_TRANSCRIPT_MAX_CHARS = 200_000;

/** Transcript slice handed to the summary prompt (context safety). */
export const MEETING_SUMMARY_INPUT_MAX_CHARS = 24_000;

/** Cap on the stored/emitted summary text. */
export const MEETING_SUMMARY_MAX_CHARS = 4_000;

/**
 * Summarizer instructions.
 *
 * The summary is stored as Markdown and rendered as Markdown on
 * `/meetings/:id`, so the shape asked for here IS the shape a reader sees.
 * It used to ask for a few sentences plus a flat bullet list, which
 * flattened a decision, an owner and an aside into one undifferentiated
 * run — the reader had to re-read the summary to find the part that
 * concerned them.
 *
 * Sections are conditional on purpose: a heading followed by "none" is
 * noise, and inviting the model to fill an empty section is inviting it to
 * invent one.
 */
const MEETING_SUMMARY_SYSTEM_PROMPT = [
    'You summarize meeting transcripts into Markdown for a meeting record.',
    '',
    'Structure:',
    '- Open with one short paragraph (2-4 sentences) covering what the meeting was about and what came out of it. No heading above it.',
    '- Then add only the sections the transcript actually supports, in this order, each a `###` heading followed by bullets: Discussion, Decisions, Action items, Open questions.',
    '- Name the owner on an action item when the transcript does; write "Unassigned" when it does not.',
    '',
    'Rules:',
    '- Omit any section you have nothing for. Never write a heading followed by "none" or "N/A".',
    '- Plain Markdown only: paragraphs, `###` headings, `-` bullets, `**bold**` for emphasis. No title heading, no code fences, no tables.',
    '- Never invent facts, owners, dates or decisions that are not in the transcript.',
    '- Keep the whole summary under 400 words.',
].join('\n');

/**
 * Envelope kinds the meetings processor consumes (recordings → rows).
 *
 * One processor, one path: every provider that can hand the platform a
 * meeting recording + transcript normalizes into one of these kinds and
 * lands on the SAME `ingestTranscript` pipeline. Google Meet needs no
 * connector of its own — Meet transcripts arrive through the Google
 * Workspace connector's Drive sweep as `google.meet-recording`.
 */
export const MEETING_RECORDING_EVENT_KINDS = ['zoom.recording', 'google.meet-recording'] as const;

/**
 * Envelope kind → `MeetingSource`. The kind (not the producing plugin
 * id) is authoritative, so a future connector can emit an existing kind
 * without inventing a source. Unknown kinds fall back to `import`
 * rather than guessing.
 */
const MEETING_KIND_SOURCES: Readonly<Record<string, MeetingSource>> = {
    'zoom.recording': 'zoom',
    'google.meet-recording': 'google-meet',
};

export interface CreateMeetingInput {
    title: string;
    startedAt: Date | string;
    endedAt?: Date | string | null;
    source?: MeetingSource;
    externalId?: string | null;
    participants?: MeetingParticipant[];
    workId?: string | null;
    organizationId?: string | null;
    sourceUrl?: string | null;
    /** Optional transcript captured at creation time — runs full ingest. */
    transcriptText?: string | null;
}

export interface UpdateMeetingInput {
    title?: string;
    startedAt?: Date | string;
    endedAt?: Date | string | null;
    workId?: string | null;
    participants?: MeetingParticipant[];
    sourceUrl?: string | null;
}

export interface IngestTranscriptResult {
    meeting: Meeting;
    /** Present when the best-effort AI summary succeeded. */
    summary?: string;
    /** True when a Memory observation was saved (best-effort). */
    memorySaved: boolean;
    /** True when the `meeting.transcript` envelope landed (best-effort). */
    envelopeEmitted: boolean;
}

const VALID_SOURCES: readonly MeetingSource[] = ['zoom', 'google-meet', 'manual', 'import'];

/**
 * Meetings v1 (Wave 8, feature a) — org-wide and per-Work meetings,
 * transcript-first.
 *
 * Owner-scoped CRUD over the `meetings` table plus the transcript
 * pipeline:
 *
 *   `ingestTranscript(meeting, text)` →
 *     1. store the transcript (capped),
 *     2. generate an AI `summary` via `AiFacadeService` — BEST-EFFORT
 *        (no provider / provider error never fails the ingest),
 *     3. save a Memory observation via `AgentMemoryFacadeService` with
 *        meeting provenance — BEST-EFFORT (mirrors the spine's quiet
 *        `NoProviderError` handling),
 *     4. emit a `meeting.transcript` envelope into the event-ingest
 *        spine — the spine's drain writes the Activity entry with
 *        `sourceUrl` provenance, so meetings surface on Activities and
 *        chat recall exactly like every other connector event.
 *
 * Recordings→Meetings processor: at boot this service registers a
 * kind processor for every kind in {@link MEETING_RECORDING_EVENT_KINDS}
 * — `zoom.recording` (pulled by the zoom-connector event source) and
 * `google.meet-recording` (Meet transcript documents picked up by the
 * google-workspace-connector's Drive sweep). Each becomes a Meeting row
 * (`createIfNew`, dedupe on owner+source+externalId) whose `source` is
 * derived from the envelope kind, and, when the envelope carries
 * transcript text, runs `ingestTranscript`. The processor is
 * idempotent: re-delivered envelopes dedupe on the meeting row, and a
 * transcript identical to the stored one is not re-ingested.
 *
 * LIVE BOT-JOIN (an Ever Works bot joining meetings/calls to capture
 * transcripts in real time) is the documented v2 FOLLOW-UP — it will
 * feed this same `ingestTranscript` path, so nothing here changes for
 * it. A future provider adds its kind to
 * {@link MEETING_RECORDING_EVENT_KINDS} plus one `MEETING_KIND_SOURCES`
 * entry and inherits the whole pipeline.
 */
@Injectable()
export class MeetingsService implements OnModuleInit {
    private readonly logger = new Logger(MeetingsService.name);

    constructor(
        private readonly repository: MeetingRepository,
        private readonly eventIngest: EventIngestService,
        @Optional() private readonly aiFacade?: AiFacadeService,
        @Optional() private readonly agentMemory?: AgentMemoryFacadeService,
    ) {}

    /** Register the recordings→Meetings processor on the ingest spine. */
    onModuleInit(): void {
        this.eventIngest.registerKindProcessor({
            kinds: MEETING_RECORDING_EVENT_KINDS,
            process: (event) => this.processRecordingEvent(event),
        });
    }

    // ── CRUD (owner-scoped) ─────────────────────────────────────────────

    async createForUser(userId: string, input: CreateMeetingInput): Promise<Meeting> {
        const title = (input.title ?? '').trim();
        if (!title) {
            throw new BadRequestException('Meeting title is required');
        }
        const startedAt = this.toDate(input.startedAt);
        if (!startedAt) {
            throw new BadRequestException('Meeting startedAt must be a valid date');
        }
        const source = input.source ?? 'manual';
        if (!VALID_SOURCES.includes(source)) {
            throw new BadRequestException(`Unknown meeting source: ${String(source)}`);
        }

        const { meeting } = await this.repository.createIfNew({
            userId,
            organizationId: input.organizationId ?? null,
            workId: input.workId ?? null,
            title: title.slice(0, 500),
            startedAt,
            endedAt: this.toDate(input.endedAt) ?? null,
            source,
            externalId: input.externalId ?? null,
            participants: input.participants ?? [],
            sourceUrl: input.sourceUrl ?? null,
        });

        if (input.transcriptText && input.transcriptText.trim().length > 0) {
            const { meeting: updated } = await this.ingestTranscript(meeting, input.transcriptText);
            return updated;
        }
        return meeting;
    }

    async listForUser(userId: string, filters: FindMeetingsFilters = {}): Promise<Meeting[]> {
        return this.repository.findByUser(userId, filters);
    }

    /** 404 for missing AND for other owners' rows — no existence leak. */
    async getForUser(userId: string, id: string): Promise<Meeting> {
        const meeting = await this.repository.findById(id);
        if (!meeting || meeting.userId !== userId) {
            throw new NotFoundException(`Meeting ${id} not found`);
        }
        return meeting;
    }

    async updateForUser(userId: string, id: string, input: UpdateMeetingInput): Promise<Meeting> {
        const meeting = await this.getForUser(userId, id);

        const patch: Record<string, unknown> = {};
        if (input.title !== undefined) {
            const title = input.title.trim();
            if (!title) throw new BadRequestException('Meeting title cannot be empty');
            patch.title = title.slice(0, 500);
        }
        if (input.startedAt !== undefined) {
            const startedAt = this.toDate(input.startedAt);
            if (!startedAt) throw new BadRequestException('Meeting startedAt must be a valid date');
            patch.startedAt = startedAt;
        }
        if (input.endedAt !== undefined) {
            patch.endedAt = this.toDate(input.endedAt) ?? null;
        }
        if (input.workId !== undefined) patch.workId = input.workId;
        if (input.participants !== undefined) patch.participants = input.participants;
        if (input.sourceUrl !== undefined) patch.sourceUrl = input.sourceUrl;

        if (Object.keys(patch).length > 0) {
            await this.repository.update(meeting.id, patch);
        }
        return this.getForUser(userId, id);
    }

    async deleteForUser(userId: string, id: string): Promise<void> {
        const meeting = await this.getForUser(userId, id);
        await this.repository.delete(meeting.id);
    }

    // ── Transcript pipeline ─────────────────────────────────────────────

    /** Owner-scoped transcript ingest (the API surface). */
    async ingestTranscriptForUser(
        userId: string,
        id: string,
        transcriptText: string,
    ): Promise<IngestTranscriptResult> {
        const meeting = await this.getForUser(userId, id);
        if (!transcriptText || transcriptText.trim().length === 0) {
            throw new BadRequestException('Transcript text is required');
        }
        return this.ingestTranscript(meeting, transcriptText);
    }

    /**
     * Store the transcript, then run the best-effort fan-out (summary →
     * memory → envelope). Only the transcript WRITE can fail this call —
     * every enrichment failure degrades gracefully and never breaks
     * ingest.
     */
    async ingestTranscript(
        meeting: Meeting,
        transcriptText: string,
    ): Promise<IngestTranscriptResult> {
        const text =
            transcriptText.length > MEETING_TRANSCRIPT_MAX_CHARS
                ? transcriptText.slice(0, MEETING_TRANSCRIPT_MAX_CHARS)
                : transcriptText;

        await this.repository.attachTranscript(meeting.id, text);
        meeting.transcriptText = text;

        const summary = await this.trySummarize(meeting, text);
        if (summary) {
            await this.tryAttachSummary(meeting, summary);
        }

        const memorySaved = await this.trySaveMemory(meeting, summary);
        const envelopeEmitted = await this.tryEmitTranscriptEnvelope(meeting, text, summary);

        return {
            meeting,
            ...(summary ? { summary } : {}),
            memorySaved,
            envelopeEmitted,
        };
    }

    /**
     * Recordings→Meetings processor for the ingest spine (registered in
     * `onModuleInit`). Idempotent per envelope: the meeting row dedupes
     * on (owner, source, externalId) and an unchanged transcript is not
     * re-ingested.
     */
    async processRecordingEvent(event: IngestedEvent): Promise<void> {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const externalId =
            typeof payload.meetingExternalId === 'string' && payload.meetingExternalId.length > 0
                ? payload.meetingExternalId
                : (event.subjectExternalId ?? null);
        if (!externalId) {
            this.logger.warn(`Recording event ${event.id} has no meeting external id — skipped`);
            return;
        }

        const startedAt =
            (typeof payload.startTime === 'string' ? this.toDate(payload.startTime) : null) ??
            event.occurredAt;
        const durationMinutes =
            typeof payload.durationMinutes === 'number' && Number.isFinite(payload.durationMinutes)
                ? payload.durationMinutes
                : null;
        const endedAt = durationMinutes
            ? new Date(startedAt.getTime() + durationMinutes * 60_000)
            : null;
        const title =
            (typeof payload.topic === 'string' && payload.topic.trim().length > 0
                ? payload.topic.trim()
                : (event.title ?? '')) || 'Meeting';

        const { meeting } = await this.repository.createIfNew({
            userId: event.userId,
            organizationId: event.organizationId ?? null,
            workId: event.workId ?? null,
            title: title.slice(0, 500),
            startedAt,
            endedAt,
            source: MEETING_KIND_SOURCES[event.kind] ?? 'import',
            externalId,
            participants: [],
            sourceUrl: event.sourceUrl ?? null,
        });

        const transcript = typeof payload.transcriptText === 'string' ? payload.transcriptText : '';
        if (transcript.trim().length > 0 && transcript !== meeting.transcriptText) {
            await this.ingestTranscript(meeting, transcript);
        }
    }

    // ── Best-effort enrichment legs ─────────────────────────────────────

    /**
     * AI summary — best-effort, never fails ingest. `NoProviderError`
     * (no AI provider enabled for this user/Work) is the expected quiet
     * case — debug, not warn (mirrors the spine's memory leg).
     */
    private async trySummarize(
        meeting: Meeting,
        transcriptText: string,
    ): Promise<string | undefined> {
        if (!this.aiFacade) return undefined;
        try {
            const completion = await this.aiFacade.createChatCompletion(
                {
                    messages: [
                        {
                            role: 'system',
                            content: MEETING_SUMMARY_SYSTEM_PROMPT,
                        },
                        {
                            role: 'user',
                            content: `Meeting: ${meeting.title}\nStarted: ${meeting.startedAt.toISOString()}\n\nTranscript:\n${transcriptText.slice(0, MEETING_SUMMARY_INPUT_MAX_CHARS)}`,
                        },
                    ],
                    temperature: 0.2,
                    // Room for the opening paragraph plus the sections the
                    // prompt asks for. The 400-word ceiling above keeps the
                    // result well inside MEETING_SUMMARY_MAX_CHARS, so the
                    // stored text is never a sentence cut in half.
                    maxTokens: 900,
                },
                {
                    userId: meeting.userId,
                    ...(meeting.workId ? { workId: meeting.workId } : {}),
                },
            );
            const content = completion.choices?.[0]?.message?.content;
            const summary = typeof content === 'string' ? content.trim() : '';
            return summary.length > 0 ? summary.slice(0, MEETING_SUMMARY_MAX_CHARS) : undefined;
        } catch (error) {
            this.logBestEffort('Summary generation skipped', meeting.id, error);
            return undefined;
        }
    }

    /** Persist the summary — best-effort (the transcript already landed). */
    private async tryAttachSummary(meeting: Meeting, summary: string): Promise<void> {
        try {
            await this.repository.attachSummary(meeting.id, summary);
            meeting.summary = summary;
        } catch (error) {
            this.logBestEffort('Summary write skipped', meeting.id, error);
        }
    }

    /**
     * Memory observation with meeting provenance — best-effort, never
     * fails ingest. Provenance metadata is REQUIRED on these memories
     * (drives Memory source facets + chat citations via `sourceUrl`).
     */
    private async trySaveMemory(meeting: Meeting, summary: string | undefined): Promise<boolean> {
        if (!this.agentMemory) return false;
        try {
            const excerpt = summary ?? (meeting.transcriptText ?? '').slice(0, 500);
            await this.agentMemory.saveMemory(
                {
                    content: `Meeting "${meeting.title}" (${meeting.startedAt.toISOString()}): ${excerpt}`,
                    tags: [
                        'meeting',
                        `source:${meeting.source}`,
                        ...(meeting.workId ? [`work:${meeting.workId}`] : []),
                    ],
                    metadata: this.provenance(meeting),
                },
                {
                    userId: meeting.userId,
                    ...(meeting.workId ? { workId: meeting.workId } : {}),
                },
            );
            return true;
        } catch (error) {
            this.logBestEffort('Memory write skipped', meeting.id, error);
            return false;
        }
    }

    /**
     * Emit the `meeting.transcript` envelope into the event-ingest
     * spine — its drain writes the Activity entry (with `sourceUrl`
     * provenance) and the spine-side memory one-liner. Content-hashed
     * `sourceEventId`, so re-ingesting the SAME transcript dedupes while
     * a revised transcript lands as a new event. Best-effort.
     */
    private async tryEmitTranscriptEnvelope(
        meeting: Meeting,
        transcriptText: string,
        summary: string | undefined,
    ): Promise<boolean> {
        try {
            const contentHash = createHash('sha256')
                .update(transcriptText)
                .digest('hex')
                .slice(0, 16);
            const envelope: IngestedEventEnvelope = {
                id: randomUUID(),
                source: 'meetings',
                sourceEventId: `${meeting.id}:transcript:${contentHash}`,
                kind: 'meeting.transcript',
                occurredAt: meeting.startedAt.toISOString(),
                subject: {
                    type: 'meeting',
                    externalId: meeting.externalId ?? meeting.id,
                    title: meeting.title,
                },
                ...(meeting.sourceUrl ? { sourceUrl: meeting.sourceUrl } : {}),
                ...(meeting.workId ? { workId: meeting.workId } : {}),
                ...(meeting.organizationId ? { organizationId: meeting.organizationId } : {}),
                payload: {
                    meetingId: meeting.id,
                    source: meeting.source,
                    transcriptChars: transcriptText.length,
                    ...(summary ? { summary: summary.slice(0, 2000) } : {}),
                },
            };
            const result = await this.eventIngest.ingest(meeting.userId, [envelope]);
            return result.inserted > 0 || result.duplicates > 0;
        } catch (error) {
            this.logBestEffort('Transcript envelope skipped', meeting.id, error);
            return false;
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private provenance(meeting: Meeting): Record<string, unknown> {
        return {
            meetingId: meeting.id,
            source: meeting.source,
            startedAt: meeting.startedAt.toISOString(),
            ...(meeting.externalId ? { externalId: meeting.externalId } : {}),
            ...(meeting.sourceUrl ? { sourceUrl: meeting.sourceUrl } : {}),
            ...(meeting.workId ? { workId: meeting.workId } : {}),
            ...(meeting.organizationId ? { organizationId: meeting.organizationId } : {}),
        };
    }

    private logBestEffort(prefix: string, meetingId: string, error: unknown): void {
        const isQuiet = error instanceof Error && error.name === 'NoProviderError';
        const message = `${prefix} for meeting ${meetingId}: ${
            error instanceof Error ? error.message : String(error)
        }`;
        if (isQuiet) {
            this.logger.debug(message);
        } else {
            this.logger.warn(message);
        }
    }

    private toDate(value: Date | string | null | undefined): Date | null {
        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : value;
        }
        if (typeof value === 'string') {
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        }
        return null;
    }
}
