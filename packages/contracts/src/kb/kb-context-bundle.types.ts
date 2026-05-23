import type { KbDocumentBodyDto } from './kb-document.types.js';

/**
 * EW-641 Phase 2/b row 32b — wire-format shape of a resolved KB context
 * bundle as carried by `StepExecutionContext.kbContext` into pipeline
 * step executors.
 *
 * Data-only mirror of `KbContextBundle` (in `@ever-works/agent`). The
 * agent-side bundle adds a `format(opts?)` method that renders the
 * `<kb>...</kb>` block via `formatKbContext` (row 31); the data shape
 * here is the part that:
 *  - is safe to serialize (no methods, no cycles),
 *  - is consumable by any pipeline plugin (in `@ever-works/plugin`'s
 *    public package) without dragging in agent internals,
 *  - is forwarded by `PipelineFacadeService.createStepExecutionContext`
 *    to step executors via the engine-provided `execContext`.
 *
 * Priority per spec §15.4: `alwaysInjected` first (default whitelist =
 * `brand` + `legal` + `style` + `glossary`), then `queryRetrieved`
 * (RRF-fused lexical + semantic over the user query, when present).
 * The agent's factory dedupes `queryRetrieved` against `alwaysInjected`
 * by `id` before exposing — consumers can iterate the two arrays
 * back-to-back without worrying about double-counting.
 */
export interface KbContextBundleData {
	readonly alwaysInjected: ReadonlyArray<KbDocumentBodyDto>;
	readonly queryRetrieved: ReadonlyArray<KbDocumentBodyDto>;
}
