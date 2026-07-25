import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { MeetingSource } from '../entities/meeting.entity';
import type { MeetingRepository } from './meeting.repository';

/**
 * Meetings v1 (Wave 8, feature a) — chat tools for the meetings
 * surface, per the program DoD rule that every new entity ships with
 * chat tools + keyword slots.
 *
 * Mirrors `ingest/agent-ingest-tools.ts`: a descriptor-factory the
 * tool assembly concatenates at run time (type-only import of
 * `TaskToolDescriptor`, so the Tasks runtime graph is NOT pulled into
 * the meetings subpath).
 *
 * Keyword slots: "meetings", "transcript", "recording", "call",
 * "standup" style asks route here; results carry `sourceUrl` so chat
 * answers link back to the recording.
 */

export interface ListMeetingsArgs {
    /** Optional Work filter — per-Work meetings view. */
    workId?: string;
    /** Optional source filter: zoom | google-meet | manual | import. */
    source?: string;
    /** Max rows (default 20, capped at 50). */
    limit?: number;
}

export interface MeetingSummaryView {
    id: string;
    title: string;
    startedAt: string;
    endedAt?: string;
    source: string;
    workId?: string;
    sourceUrl?: string;
    participants: { name: string; email?: string }[];
    hasTranscript: boolean;
    summary?: string;
}

const VALID_SOURCES: readonly string[] = ['zoom', 'google-meet', 'manual', 'import'];

export function buildMeetingTools(args: {
    /** Owner scope — tools only ever read this user's rows. */
    userId: string;
    repository: MeetingRepository;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    const toView = (meeting: {
        id: string;
        title: string;
        startedAt: Date;
        endedAt?: Date | null;
        source: string;
        workId?: string | null;
        sourceUrl?: string | null;
        participants: { name: string; email?: string }[];
        transcriptText?: string | null;
        summary?: string | null;
    }): MeetingSummaryView => ({
        id: meeting.id,
        title: meeting.title,
        startedAt: meeting.startedAt.toISOString(),
        ...(meeting.endedAt ? { endedAt: meeting.endedAt.toISOString() } : {}),
        source: meeting.source,
        ...(meeting.workId ? { workId: meeting.workId } : {}),
        ...(meeting.sourceUrl ? { sourceUrl: meeting.sourceUrl } : {}),
        participants: meeting.participants ?? [],
        hasTranscript: !!meeting.transcriptText,
        ...(meeting.summary ? { summary: meeting.summary } : {}),
    });

    out.push({
        name: 'list_meetings',
        description:
            'List the current user’s captured meetings (org-wide, or filtered to one Work), newest first — synced recordings, imported and manual meetings alike. Each meeting carries a sourceUrl linking to the recording — include it when citing a meeting.',
        parameters: {
            type: 'object',
            properties: {
                workId: {
                    type: 'string',
                    description: 'Optional Work id — only meetings routed to that Work.',
                },
                source: {
                    type: 'string',
                    description: 'Optional source filter: zoom, google-meet, manual or import.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max meetings to return (default 20, capped at 50).',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ListMeetingsArgs;
            const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
            try {
                const rows = await args.repository.findByUser(args.userId, {
                    ...(a.workId ? { workId: a.workId } : {}),
                    ...(a.source && VALID_SOURCES.includes(a.source)
                        ? { source: a.source as MeetingSource }
                        : {}),
                    limit,
                });
                return { meetings: rows.map(toView) };
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<ListMeetingsArgs, { meetings: MeetingSummaryView[] }>);

    out.push({
        name: 'get_meeting_summary',
        description:
            'Get one meeting’s AI summary plus its metadata (participants, timing, recording link). Use after list_meetings when the user asks what a meeting was about or what was decided. When no summary exists yet, the transcript availability flag says whether one can be generated.',
        parameters: {
            type: 'object',
            properties: {
                meetingId: {
                    type: 'string',
                    description: 'The meeting id (from list_meetings).',
                },
            },
            required: ['meetingId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { meetingId?: string };
            if (!a.meetingId) {
                return { error: 'meetingId is required' };
            }
            try {
                const meeting = await args.repository.findById(a.meetingId);
                // Owner scope: other users' meetings are indistinguishable
                // from missing ones — no existence leak.
                if (!meeting || meeting.userId !== args.userId) {
                    return { error: `Meeting ${a.meetingId} not found` };
                }
                return { meeting: toView(meeting) };
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<{ meetingId?: string }, { meeting: MeetingSummaryView }>);

    return out;
}
