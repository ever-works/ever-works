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
