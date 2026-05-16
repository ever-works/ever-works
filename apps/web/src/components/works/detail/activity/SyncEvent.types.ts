/**
 * EW-628 sync-event row types. Extracted from {@link ./SyncEventRow.tsx}
 * so consumers (the upcoming FeedRow adapter, API-client glue, fixtures)
 * can import the discriminated union without pulling the component
 * implementation — keeps test-only and SSR-only call sites lean.
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §5.6.
 *
 * The shape mirrors the API-side `DataSyncOutcome` in
 * `apps/api/src/data-sync/data-sync.types.ts`, but uses `kind` instead
 * of `status` to align with the activity-feed convention where
 * `kind` discriminates row types and `status` is reserved for HTTP /
 * pipeline lifecycle values.
 */

export type SyncEventSource = 'webhook' | 'poll' | 'manual';

export type SyncEvent =
    | {
          kind: 'success';
          source: SyncEventSource;
          beforeSha?: string;
          afterSha?: string;
          filesChanged: number;
          durationMs?: number;
      }
    | {
          kind: 'skipped';
          source: SyncEventSource;
          reason: string;
      }
    | {
          kind: 'failed';
          source: SyncEventSource;
          errorClass: string;
          errorTail: string;
      };

/** Narrow `kind` values used as React keys and `data-event-kind` attrs. */
export type SyncEventKind = SyncEvent['kind'];
