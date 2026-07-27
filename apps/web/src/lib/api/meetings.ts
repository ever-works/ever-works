import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Meetings — server-only client for the owner-scoped meetings surface
 * (`apps/api/src/meetings/meetings.controller.ts`).
 *
 *   GET    /api/meetings                 list mine (workId/source/limit/offset)
 *   POST   /api/meetings                 create (manual/import)
 *   GET    /api/meetings/:id             get one (INCLUDES transcriptText)
 *   PATCH  /api/meetings/:id             partial update
 *   DELETE /api/meetings/:id             204
 *   POST   /api/meetings/:id/transcript  attach transcript (summary fan-out)
 *
 * Web-side mirror of the API's `MeetingView` wire shape, kept in
 * lockstep manually so `apps/web` needs no runtime dependency on the
 * agent package for a small projection — the same idiom
 * `lib/api/goals.ts` and `lib/api/missions.ts` use. Date fields are
 * ISO strings on the wire and stay strings until a renderer formats
 * them.
 *
 * `dedupeKey` deliberately never appears here: the API's `toView` is an
 * explicit projection that drops it, and the contract spec asserts it
 * never leaves the API.
 */

// Pure contract values/types shared with `'use client'` components live in
// a `server-only`-free module so forms can import them without pulling
// this module into the client bundle. Re-exported for server callers.
export {
    MEETING_SOURCES,
    MEETING_CREATABLE_SOURCES,
    MEETING_TRANSCRIPT_MAX_CHARS,
    MEETING_TITLE_MAX_CHARS,
    MEETING_SOURCE_URL_MAX_CHARS,
    MEETING_EXTERNAL_ID_MAX_CHARS,
    MEETING_PARTICIPANT_NAME_MAX_CHARS,
    MEETING_PARTICIPANT_EMAIL_MAX_CHARS,
    MEETING_PARTICIPANTS_MAX,
    parseParticipants,
    formatParticipants,
    type MeetingSource,
    type MeetingParticipant,
} from './meetings.shared';
import type { MeetingSource, MeetingParticipant } from './meetings.shared';

/**
 * One meeting as the API projects it. `transcriptText` is present ONLY
 * on the single-meeting reads (detail / create / update / transcript
 * ingest) — list rows carry `hasTranscript` instead, which is why the
 * field is optional here rather than nullable.
 */
export interface Meeting {
    id: string;
    title: string;
    startedAt: string;
    endedAt: string | null;
    source: string;
    externalId: string | null;
    workId: string | null;
    organizationId: string | null;
    participants: MeetingParticipant[];
    sourceUrl: string | null;
    summary: string | null;
    hasTranscript: boolean;
    transcriptText?: string | null;
    createdAt: string;
}

export interface CreateMeetingInput {
    title: string;
    startedAt: string;
    endedAt?: string;
    source?: MeetingSource;
    externalId?: string;
    workId?: string;
    participants?: MeetingParticipant[];
    sourceUrl?: string;
    /** Optional transcript captured at creation — runs the full pipeline. */
    transcriptText?: string;
}

export interface UpdateMeetingInput {
    title?: string;
    startedAt?: string;
    endedAt?: string | null;
    /** `null` re-routes the meeting back to org-wide. */
    workId?: string | null;
    participants?: MeetingParticipant[];
    /** `null` clears the recording link. */
    sourceUrl?: string | null;
}

/**
 * `POST /:id/transcript` result. The transcript WRITE is the only part
 * that can fail the call — `summary` is absent and both booleans are
 * false whenever the best-effort enrichment legs (AI summary → memory
 * observation → ingest envelope) could not run.
 */
export interface IngestTranscriptResult {
    meeting: Meeting;
    summary?: string;
    memorySaved: boolean;
    envelopeEmitted: boolean;
}

export interface ListMeetingsInput {
    workId?: string;
    source?: MeetingSource;
    /** The API clamps to 1–100 and defaults to 20. */
    limit?: number;
    offset?: number;
}

function buildListEndpoint(input?: ListMeetingsInput): string {
    const params = new URLSearchParams();
    if (input?.workId) params.set('workId', input.workId);
    if (input?.source) params.set('source', input.source);
    if (input?.limit) params.set('limit', String(input.limit));
    if (input?.offset && input.offset > 0) params.set('offset', String(input.offset));
    const qs = params.toString();
    return qs ? `/meetings?${qs}` : '/meetings';
}

export const meetingsAPI = {
    async list(input?: ListMeetingsInput): Promise<Meeting[]> {
        return serverFetch<Meeting[]>(buildListEndpoint(input), { method: 'GET' });
    },

    /**
     * `null` for a missing meeting AND for another owner's row — the API
     * 404s identically in both cases (no existence leak), and the detail
     * page turns that into `notFound()`.
     */
    async get(id: string): Promise<Meeting | null> {
        try {
            return await serverFetch<Meeting>(`/meetings/${id}`, { method: 'GET' });
        } catch {
            return null;
        }
    },

    async create(input: CreateMeetingInput): Promise<Meeting> {
        return serverMutation<Meeting>({
            endpoint: '/meetings',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async update(id: string, input: UpdateMeetingInput): Promise<Meeting> {
        return serverMutation<Meeting>({
            endpoint: `/meetings/${id}`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    /** 204 No Content — `serverFetch` resolves to undefined on an empty body. */
    async remove(id: string): Promise<void> {
        await serverMutation<void>({
            endpoint: `/meetings/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async ingestTranscript(id: string, transcriptText: string): Promise<IngestTranscriptResult> {
        return serverMutation<IngestTranscriptResult>({
            endpoint: `/meetings/${id}/transcript`,
            data: { transcriptText },
            method: 'POST',
            wrapInData: false,
        });
    },
};
