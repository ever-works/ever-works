import 'server-only';
import { serverFetch } from './server-api';

/**
 * Wave 6/8 feature j — server-only client for the ingested-event feed
 * (`GET /api/ingest/events` in `apps/api/src/ingest/ingest.controller.ts`).
 *
 * The spine now stamps `workId` on every event whose connector could
 * resolve a `workHint`, which is what makes a per-Work "what happened on
 * this Work's repos / channels / trackers" feed possible at all. The
 * owner scope is applied server-side first and unconditionally, so a
 * `workId` the caller does not own returns an empty page rather than
 * someone else's events.
 */

export interface IngestedEventView {
    id: string;
    source: string;
    kind: string;
    occurredAt: string;
    actorName: string | null;
    title: string | null;
    sourceUrl: string | null;
    workId: string | null;
    processed: boolean;
}

export interface ListIngestedEventsOptions {
    workId?: string;
    /** Producing plugin id, e.g. `github`, `jira-connector`. */
    source?: string;
    /** 1–100; the API clamps and defaults to 20. */
    limit?: number;
}

export const ingestedEventsAPI = {
    /** `GET /api/ingest/events?workId=&source=&limit=` */
    list: async (opts: ListIngestedEventsOptions = {}) => {
        const params = new URLSearchParams();
        if (opts.workId) params.append('workId', opts.workId);
        if (opts.source) params.append('source', opts.source);
        if (typeof opts.limit === 'number') params.append('limit', String(opts.limit));
        const query = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<{ data: IngestedEventView[] }>(`/ingest/events${query}`);
    },
};
