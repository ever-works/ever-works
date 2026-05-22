import type { KbDocumentBodyDto } from '@ever-works/contracts';
import { formatKbContext, type FormatKbContextOptions } from './kb-prompt-formatter';

/**
 * EW-641 Phase 2/b row 32a — `KbContextBundle` value type returned by
 * `KnowledgeBaseService.resolveContext(workId, opts)`.
 *
 * Spec §15.4 priority: `alwaysInjected` first (default whitelist =
 * brand + legal + style + glossary; configurable per-Work via
 * `WorkKbConfig.retrievalConfig.classFilters` — row 41 budget gauge),
 * then `queryRetrieved` (RRF-fused lexical + semantic over the user's
 * query, when present). The bundle is the single value plumbed into
 * the pipeline plugin invocation (row 32b), so individual pipelines
 * never need to know how the context was assembled.
 *
 * `format(opts)` delegates to `formatKbContext` (row 31) — every
 * Phase 2/b consumer gets the same `<kb>...</kb>` block shape and the
 * same truncation contract without re-implementing it.
 *
 * **Determinism.** Input order is preserved; the bundle factory
 * dedupes `queryRetrieved` against `alwaysInjected` by `id` (always-
 * injected wins — if `brand/voice` is both always-injected AND a
 * top RRF hit, it appears once, in the always-injected slot).
 *
 * **Pure.** No I/O, no module state. The factory only marshals; the
 * service layer (`resolveContext`) is the one that touches the DB.
 */
export interface KbContextBundle {
    readonly alwaysInjected: ReadonlyArray<KbDocumentBodyDto>;
    readonly queryRetrieved: ReadonlyArray<KbDocumentBodyDto>;
    format(options?: FormatKbContextOptions): string;
}

/**
 * Build a `KbContextBundle` from two doc lists, deduping `queryRetrieved`
 * against `alwaysInjected` by `id`.
 *
 * The returned bundle's `format()` concatenates the two lists in
 * priority order (alwaysInjected first) and delegates to `formatKbContext`.
 *
 * Pure factory — safe for any context (service code, eval harness,
 * tests). Callers (notably `KnowledgeBaseService.resolveContext`) are
 * responsible for the actual data fetches.
 */
export function buildKbContextBundle(
    alwaysInjected: ReadonlyArray<KbDocumentBodyDto>,
    queryRetrieved: ReadonlyArray<KbDocumentBodyDto>,
): KbContextBundle {
    const alwaysIds = new Set<string>();
    for (const d of alwaysInjected) alwaysIds.add(d.id);

    // Dedup queryRetrieved by id (within the list itself AND against
    // alwaysInjected). A doc that survived RRF + appears in the always-
    // injected whitelist would otherwise be emitted twice; keep the
    // alwaysInjected copy and drop the duplicate from queryRetrieved.
    const seenQuery = new Set<string>();
    const dedupedQueryRetrieved: KbDocumentBodyDto[] = [];
    for (const d of queryRetrieved) {
        if (alwaysIds.has(d.id)) continue;
        if (seenQuery.has(d.id)) continue;
        seenQuery.add(d.id);
        dedupedQueryRetrieved.push(d);
    }

    const frozenAlways = Object.freeze([...alwaysInjected]);
    const frozenQuery = Object.freeze(dedupedQueryRetrieved);

    return {
        alwaysInjected: frozenAlways,
        queryRetrieved: frozenQuery,
        format(options?: FormatKbContextOptions): string {
            return formatKbContext([...frozenAlways, ...frozenQuery], options);
        },
    };
}
