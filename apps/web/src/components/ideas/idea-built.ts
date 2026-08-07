import type { IdeaWorkLink, WorkProposal } from '@/lib/api/work-proposals';

/**
 * The single answer to "has this Idea been built?", shared by `IdeaCard`
 * and the `/ideas/[id]` detail page so a card and the page it opens can
 * never disagree.
 *
 * Lives in its own module (no `'use client'` / `'server-only'`) so both
 * the client card and the server page can import it.
 */
export interface IdeaBuiltState {
    /** True when at least one Work has come out of this Idea. */
    isBuilt: boolean;
    /** How many Works it produced — 0 when not built. */
    workCount: number;
    /** Best "View Work" target, or null when there is nothing to open. */
    workId: string | null;
}

/**
 * Built-ness is read from the `idea_works` provenance table, via two
 * views of it that are reconciled rather than ranked:
 *
 *  - `links` — the full link list, which only the detail page fetches.
 *  - `linkedWorksCount` / `latestLinkedWorkId` — the same table, rolled
 *    up per Idea by the list + detail endpoints for the cards.
 *
 * `acceptedWorkId` remains as a last-resort fallback for rows that
 * predate the provenance table.
 *
 * Why not `acceptedWorkId` alone: it is only stamped when the Idea's
 * status legally transitions to ACCEPTED, so it stays null for a Work
 * built from a queued / building / failed / dismissed Idea — and the
 * Ideas list routes every one of those through the same
 * `/works/new?proposal=…` build flow. Reading built-ness off it alone
 * makes real builds invisible.
 *
 * It is still consulted last as a fallback so a response predating the
 * rollup fields (or a cached page) keeps working.
 *
 * NOTE on link kinds: every kind counts, not just `built` / `rebuilt`.
 * A Work created through `/works/new?proposal=…` is recorded as
 * `linked`, and that is the most common way users build an Idea.
 */
export function deriveIdeaBuiltState(
    idea: Pick<
        WorkProposal,
        'status' | 'acceptedWorkId' | 'linkedWorksCount' | 'latestLinkedWorkId'
    >,
    links?: ReadonlyArray<Pick<IdeaWorkLink, 'workId'>>,
): IdeaBuiltState {
    const acceptedWorkId =
        typeof idea.acceptedWorkId === 'string' && idea.acceptedWorkId.length > 0
            ? idea.acceptedWorkId
            : null;

    // Both sources read the same table, so normally they agree. Take the
    // larger rather than preferring one: the detail page hands us a list
    // it degrades to `[]` when `GET :id/works` fails, and an empty list is
    // indistinguishable from "genuinely no links" — so a blip there must
    // not flip a built Idea back to "not built". The reverse also holds:
    // links refreshed after a build land before the rollup does.
    const count = Math.max(links?.length ?? 0, idea.linkedWorksCount ?? 0);
    const workId = acceptedWorkId ?? links?.[0]?.workId ?? idea.latestLinkedWorkId ?? null;

    // `acceptedWorkId` counts on its own, at any status — it is only ever
    // written alongside a real Work, and a queued / building / failed Idea
    // that already produced one must still offer "View Work" rather than
    // sending the user to rebuild something that exists.
    const isBuilt = count > 0 || acceptedWorkId !== null;

    return {
        isBuilt,
        // An `accepted` Idea with no link rows (pre-provenance data) still
        // produced exactly one Work — report 1 rather than a bare 0 that
        // would contradict the Built badge next to it.
        workCount: count > 0 ? count : isBuilt ? 1 : 0,
        workId,
    };
}
