import { getWorkCapabilities, workKindHasItems } from '@ever-works/contracts';

/**
 * Picking a seeded Work by what its kind renders.
 *
 * Specs that browse the SEEDED user's existing Works (rather than create their
 * own) cannot assume `works[0]` is any particular kind: `GET /api/works` lists
 * the most recently UPDATED first (`WorkRepository.findAllAccessible` orders by
 * `work.updatedAt DESC`, not by creation), and every spec that ran earlier in
 * the same shard may have added a Work to that user or touched one of its
 * rows. The App Works specs (`flow-app-spec-settings`,
 * `flow-app-spec-recheck`, …) create App Works for the seeded user, and an App
 * Work has no Items tab by design (`WORK_KIND_CAPABILITIES.app.items.enabled
 * === false` in `packages/contracts/src/domain/work-capabilities.ts`). A spec
 * that needs a surface only some kinds render therefore picks by kind.
 *
 * The rule is the product's own predicate, imported rather than copied, so a
 * kind that gains or loses its Items tab changes this pick with it
 * (`@ever-works/contracts` ships a CommonJS build, and the e2e job builds it
 * before the web app).
 *
 * The listing is also not only the seeded user's OWN Works: it includes every
 * Work the user is a member of (`WorkQueryService.getWorks` — `userRole` is
 * `owner` for the creator, the member role otherwise), and
 * `flow-app-spec-recheck` makes the seeded user a viewer of another account's
 * Works. So among the eligible Works an owned one wins when the rows say so; a
 * member-only one is the fallback, never a reason to skip.
 */

/** The fields of a `GET /api/works` row this helper reads. */
export interface KindedWork {
    id: string;
    /** `work.kind` as the API lists it; absent/unknown kinds resolve to `default`. */
    kind?: string | null;
    /**
     * The caller's role on the Work as the API lists it (`owner`, `manager`,
     * `editor`, `viewer`). Absent when a caller's row mapping drops it, in which
     * case the pick keeps list order.
     */
    userRole?: string | null;
}

/** The first eligible Work the caller owns, else the first eligible Work at all. */
function firstEligiblePreferringOwned<T extends KindedWork>(
    works: readonly T[],
    eligible: (kind: string | null | undefined) => boolean,
): T | undefined {
    const candidates = works.filter((work) => eligible(work.kind));
    return candidates.find((work) => work.userRole === 'owner') ?? candidates[0];
}

/**
 * The first listed Work whose kind has an Items tab (`WorkTabs` renders the
 * Items/Posts/Pages crumb, `href=/works/{id}/items`), preferring one the caller
 * owns, or `undefined` when none does — callers skip truthfully rather than
 * drive a Work that cannot show it.
 */
export function firstWorkWithItemsTab<T extends KindedWork>(works: readonly T[]): T | undefined {
    return firstEligiblePreferringOwned(works, workKindHasItems);
}

/**
 * The first listed Work whose kind has the Taxonomy surface (categories, tags,
 * collections — `getWorkCapabilities(kind).taxonomy`), preferring one the
 * caller owns, or `undefined` when none does. An App Work has neither the
 * surface nor the data repository its reads clone.
 */
export function firstWorkWithTaxonomy<T extends KindedWork>(works: readonly T[]): T | undefined {
    return firstEligiblePreferringOwned(works, (kind) => getWorkCapabilities(kind).taxonomy);
}
