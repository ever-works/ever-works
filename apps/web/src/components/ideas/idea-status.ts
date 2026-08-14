import type { WorkProposalStatus } from '@/lib/api/work-proposals';

/**
 * Per-status badge palette shared by `IdeaCard` and the `/ideas/[id]`
 * detail page so a status reads identically across every surface.
 * Each entry is a soft tinted pill (ring + bg + text) plus a leading
 * status dot — `building` pulses to read as "in progress" at a glance.
 * Labels reuse the existing `dashboard.ideasPage.filters.*` i18n keys.
 *
 * Lives in its own module (no `'use client'` / `'server-only'`) so both
 * the client card and the server detail page can import it.
 */
export const STATUS_STYLES: Record<WorkProposalStatus, { badge: string; dot: string }> = {
    pending: {
        badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 ring-slate-500/20',
        dot: 'bg-slate-400',
    },
    queued: {
        badge: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 ring-indigo-500/20',
        dot: 'bg-indigo-400',
    },
    building: {
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-300 ring-amber-500/20',
        dot: 'bg-amber-500 animate-pulse',
    },
    failed: {
        badge: 'bg-danger/10 text-danger ring-danger/20',
        dot: 'bg-danger',
    },
    accepted: {
        badge: 'bg-success/10 text-success ring-success/20',
        dot: 'bg-success',
    },
    dismissed: {
        badge: 'bg-gray-500/10 text-gray-500 dark:text-gray-400 ring-gray-500/20',
        dot: 'bg-gray-400',
    },
};

/**
 * Palette for the Built pill. Same tokens as `accepted` — an Idea that
 * produced a Work reads as a success wherever it is shown.
 */
export const BUILT_BADGE_STYLE = 'bg-success/10 text-success ring-success/20';

/**
 * Statuses that describe work happening RIGHT NOW rather than where the
 * Idea ended up. They outrank built-ness in the badge (see below).
 */
const LIVE_STATUSES: ReadonlySet<WorkProposalStatus> = new Set(['queued', 'building']);

/**
 * The ONE pill an Idea shows.
 *
 * Built-ness and lifecycle status answer different questions — "what
 * exists" vs "where is this Idea in its own lifecycle" — and rendering
 * both produced pairs that read as contradictions: `Dismissed` beside
 * `Built (1)`, or `Pending` beside `Built (1)`. The lifecycle status is
 * the less useful of the two once a Work exists (nobody needs to know an
 * Idea was never formally accepted when they can see the Work it
 * produced), so built-ness wins and the status pill is dropped.
 *
 * The one exception is a LIVE build. `queued` / `building` describe
 * something happening right now, which an older Work cannot convey and
 * which the user is usually watching for — so a live status outranks
 * built-ness and keeps the pill. Once the build settles, the Idea falls
 * back to reading `Built`.
 *
 * Lives here rather than in each component so a card and the page it
 * opens can never disagree, exactly like `deriveIdeaBuiltState`.
 */
export type IdeaBadge =
    | { kind: 'status'; status: WorkProposalStatus }
    | { kind: 'built'; count: number };

export function deriveIdeaBadge(
    status: WorkProposalStatus,
    built: { isBuilt: boolean; workCount: number },
): IdeaBadge {
    if (LIVE_STATUSES.has(status)) return { kind: 'status', status };
    if (built.isBuilt) return { kind: 'built', count: built.workCount };
    return { kind: 'status', status };
}
