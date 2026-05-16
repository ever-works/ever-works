'use client';

import { cn } from '@/lib/utils/cn';

/**
 * Render one EW-628 `data-sync.*` activity row.
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §5.6.
 *
 * Three event variants share the row component to keep alignment / spacing
 * consistent across the activity feed:
 *
 *   - `success` — green dot, before/after short SHAs, files-changed
 *     count, optional duration.
 *   - `skipped` — muted dot, reason verbatim. Source chip
 *     (`webhook` | `poll` | `manual`) helps the operator triage why a
 *     particular tick didn't render.
 *   - `failed` — red dot, error class as the headline, expandable
 *     `errorTail` (last 200 chars of stderr) via a native `<details>`
 *     so we don't depend on a UI primitive that varies between dashboard
 *     pages.
 *
 * Phase 7 (this commit) lands the standalone component + its unit test.
 * Wiring into the existing FeedFilterChips / FeedRow surface needs a
 * matching `data-sync` category in `FEED_CATEGORIES`
 * (`apps/web/src/lib/api/works/activity-feed.types.ts`) and an API-client
 * adapter — those land on the Phase 7 follow-up so the type extension
 * and the cascade into FeedRow stay isolated from the row presentation.
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

interface SyncEventRowProps {
    event: SyncEvent;
}

const sha = (full?: string): string => (full ? full.slice(0, 7) : '—');

const DOT_CLASS: Record<SyncEvent['kind'], string> = {
    success: 'bg-emerald-500',
    skipped: 'bg-muted-foreground/60',
    failed: 'bg-destructive',
};

const LABEL: Record<SyncEvent['kind'], string> = {
    success: 'Sync complete',
    skipped: 'Sync skipped',
    failed: 'Sync failed',
};

export function SyncEventRow({ event }: SyncEventRowProps) {
    return (
        <div
            data-testid={`sync-event-row-${event.kind}`}
            data-event-kind={event.kind}
            className="flex items-start gap-3 py-2 px-3 border-b border-border/40 dark:border-border-dark/40 last:border-b-0"
        >
            <span
                aria-hidden
                className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', DOT_CLASS[event.kind])}
            />
            <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{LABEL[event.kind]}</span>
                    <span className="text-xs uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                        {event.source}
                    </span>
                </div>
                {event.kind === 'success' && (
                    <div className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                        <span className="font-mono">
                            {sha(event.beforeSha)} → {sha(event.afterSha)}
                        </span>{' '}
                        <span>· {event.filesChanged} files</span>
                        {typeof event.durationMs === 'number' && (
                            <span> · {Math.round(event.durationMs / 100) / 10}s</span>
                        )}
                    </div>
                )}
                {event.kind === 'skipped' && (
                    <div className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                        Reason: <code>{event.reason}</code>
                    </div>
                )}
                {event.kind === 'failed' && (
                    <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-destructive">
                            <code>{event.errorClass}</code>
                        </summary>
                        <pre className="mt-1 text-xs whitespace-pre-wrap break-words text-text-secondary dark:text-text-secondary-dark">
                            {event.errorTail}
                        </pre>
                    </details>
                )}
            </div>
        </div>
    );
}
