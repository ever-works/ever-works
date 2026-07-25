import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { IngestedEventRepository } from './ingested-event.repository';

/**
 * Event-ingest spine (Wave 6) — chat tools for the ingested-event
 * surface, per the program DoD rule that every new entity ships with
 * chat tools + keyword slots.
 *
 * Mirrors `tasks-domain/agent-task-tools.ts`: a descriptor-factory the
 * tool assembly concatenates at run time (type-only import of
 * `TaskToolDescriptor`, so the Tasks runtime graph is NOT pulled into
 * the ingest subpath).
 *
 * Keyword slots: "recent events", "what happened", "activity from
 * <source>" style asks route here; results carry `sourceUrl` so the
 * chat answer links back to the origin.
 */

export interface ListRecentEventsArgs {
    /** Optional producing plugin id filter, e.g. `slack-connector`. */
    source?: string;
    /** Max rows (default 20, capped at 50). */
    limit?: number;
}

export interface RecentEventSummary {
    id: string;
    source: string;
    kind: string;
    occurredAt: string;
    actorName?: string;
    title?: string;
    sourceUrl?: string;
    workId?: string;
    processed: boolean;
}

export function buildIngestEventTools(args: {
    /** Owner scope — tools only ever read this user's rows. */
    userId: string;
    repository: IngestedEventRepository;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'list_recent_events',
        description:
            'List recent external events ingested for the current user (messages, PRs, pages, commits from connected sources), newest first. Each event carries a sourceUrl linking back to the original item — include it when citing an event.',
        parameters: {
            type: 'object',
            properties: {
                source: {
                    type: 'string',
                    description: 'Optional plugin id to filter by (e.g. a connector id).',
                },
                limit: {
                    type: 'integer',
                    description: 'Max events to return (default 20, capped at 50).',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ListRecentEventsArgs;
            const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
            try {
                // Owner-scoped read; over-fetch when a source filter is
                // applied so the filter does not starve the page.
                const rows = await args.repository.findRecentByUser(
                    args.userId,
                    a.source ? limit * 3 : limit,
                );
                const filtered = a.source ? rows.filter((row) => row.source === a.source) : rows;
                const events: RecentEventSummary[] = filtered.slice(0, limit).map((row) => ({
                    id: row.id,
                    source: row.source,
                    kind: row.kind,
                    occurredAt: row.occurredAt.toISOString(),
                    ...(row.actorName ? { actorName: row.actorName } : {}),
                    ...(row.title ? { title: row.title } : {}),
                    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
                    ...(row.workId ? { workId: row.workId } : {}),
                    processed: !!row.processedAt,
                }));
                return { events };
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<ListRecentEventsArgs, { events: RecentEventSummary[] }>);

    return out;
}
