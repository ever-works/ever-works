import type { KbContextBundleData, KbDocumentBodyDto } from '@ever-works/contracts';
import { formatKbContext, type FormatKbContextOptions } from './kb-prompt-formatter';

/**
 * EW-641 Phase 2/b row 32a — `KbContextBundle` value type returned by
 * `KnowledgeBaseService.resolveContext(workId, opts)`.
 *
 * Spec §15.4 priority: `alwaysInjected` first (default whitelist =
 * brand + legal + style + glossary; configurable per-Work via
 * `WorkKbConfig.retrievalConfig.classFilters` — row 41 budget gauge),
 * then `decisions` (memory upgrades M5 — the Work's ACCEPTED
 * decision-class docs, rendered in their own labelled section), then
 * `queryRetrieved` (RRF-fused lexical + semantic over the user's
 * query, when present). The bundle is the single value plumbed into
 * the pipeline plugin invocation (row 32b), so individual pipelines
 * never need to know how the context was assembled.
 *
 * `format(opts)` delegates to `formatKbContext` (row 31) — every
 * Phase 2/b consumer gets the same `<kb>...</kb>` block shape and the
 * same truncation contract without re-implementing it. Decision-class
 * docs are grouped contiguously (bundle `decisions` first, then any
 * decision docs that arrived via `queryRetrieved` — e.g. a direct
 * query hit on a historical decision) so the formatter renders ONE
 * labelled decisions section; accepted decisions therefore rank above
 * generic query-retrieved docs by construction.
 *
 * **Determinism.** Input order is preserved within each list; the
 * bundle factory dedupes `decisions` against `alwaysInjected` and
 * `queryRetrieved` against both by `id` (earlier slot wins — if a doc
 * is both always-injected AND a top RRF hit, it appears once, in the
 * always-injected slot).
 *
 * **Pure.** No I/O, no module state. The factory only marshals; the
 * service layer (`resolveContext`) is the one that touches the DB.
 */
export interface KbContextBundle extends KbContextBundleData {
    readonly alwaysInjected: ReadonlyArray<KbDocumentBodyDto>;
    readonly queryRetrieved: ReadonlyArray<KbDocumentBodyDto>;
    readonly decisions: ReadonlyArray<KbDocumentBodyDto>;
    format(options?: FormatKbContextOptions): string;
}

/**
 * Build a `KbContextBundle` from the doc lists, deduping later slots
 * against earlier ones by `id` (alwaysInjected → decisions →
 * queryRetrieved).
 *
 * The returned bundle's `format()` concatenates the lists in priority
 * order — alwaysInjected first, then all decision-class docs as one
 * contiguous group (bundle decisions + query-retrieved decisions), then
 * the generic query-retrieved docs — and delegates to `formatKbContext`.
 *
 * Pure factory — safe for any context (service code, eval harness,
 * tests). Callers (notably `KnowledgeBaseService.resolveContext`) are
 * responsible for the actual data fetches.
 */
export function buildKbContextBundle(
    alwaysInjected: ReadonlyArray<KbDocumentBodyDto>,
    queryRetrieved: ReadonlyArray<KbDocumentBodyDto>,
    decisions: ReadonlyArray<KbDocumentBodyDto> = [],
): KbContextBundle {
    const alwaysIds = new Set<string>();
    for (const d of alwaysInjected) alwaysIds.add(d.id);

    // Dedup decisions by id (within the list AND against alwaysInjected —
    // decision-class docs shouldn't appear there, but the factory stays
    // defensive: earlier slot wins).
    const seenDecisions = new Set<string>();
    const dedupedDecisions: KbDocumentBodyDto[] = [];
    for (const d of decisions) {
        if (alwaysIds.has(d.id)) continue;
        if (seenDecisions.has(d.id)) continue;
        seenDecisions.add(d.id);
        dedupedDecisions.push(d);
    }

    // Dedup queryRetrieved by id (within the list itself AND against
    // alwaysInjected + decisions). A doc that survived RRF + appears in
    // an earlier slot would otherwise be emitted twice; keep the earlier
    // copy and drop the duplicate from queryRetrieved.
    const seenQuery = new Set<string>();
    const dedupedQueryRetrieved: KbDocumentBodyDto[] = [];
    for (const d of queryRetrieved) {
        if (alwaysIds.has(d.id)) continue;
        if (seenDecisions.has(d.id)) continue;
        if (seenQuery.has(d.id)) continue;
        seenQuery.add(d.id);
        dedupedQueryRetrieved.push(d);
    }

    const frozenAlways = Object.freeze([...alwaysInjected]);
    const frozenDecisions = Object.freeze(dedupedDecisions);
    const frozenQuery = Object.freeze(dedupedQueryRetrieved);

    return {
        alwaysInjected: frozenAlways,
        queryRetrieved: frozenQuery,
        decisions: frozenDecisions,
        format(options?: FormatKbContextOptions): string {
            // Group ALL decision-class docs contiguously so the formatter
            // emits a single labelled decisions section: the bundle's
            // accepted decisions first, then decision docs that arrived
            // via the query (historical hits), then generic query docs.
            const queryDecisions = frozenQuery.filter((d) => d.class === 'decision');
            const queryGeneric = frozenQuery.filter((d) => d.class !== 'decision');
            return formatKbContext(
                [...frozenAlways, ...frozenDecisions, ...queryDecisions, ...queryGeneric],
                options,
            );
        },
    };
}
