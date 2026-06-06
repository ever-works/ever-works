/**
 * EW-642 — Pure converter from the platform-side `VectorFilter` shape to
 * Qdrant's payload-filter DSL. Extracted into its own module so the spec
 * can exercise it directly without spinning up the whole plugin (the
 * filter shape is the most regression-prone piece of the integration).
 *
 * Qdrant filter DSL recap (see https://qdrant.tech/documentation/concepts/filtering/):
 *   - `must` — every condition AND-combined.
 *   - `should` — at least one condition OR-combined.
 *   - `must_not` — every condition negated.
 *   - Leaf conditions are `{ key, match: { value | any | except } }` or
 *     `{ key, range: { gte, lte, … } }`.
 *
 * The platform's `VectorFilter` exposes a small, AND-of-leaves shape
 * today; we map every field to a single `must` clause. `tags` becomes
 * `match: { any: [...] }` so a chunk matches if ANY of its tags appear
 * in the filter (set intersection semantics — same as the pgvector
 * `metadata->>'tags' ?| ARRAY[...]` interpretation).
 */

import type { VectorFilter } from '@ever-works/plugin';

/**
 * Minimal Qdrant filter shape we emit. Typed locally so the spec can
 * assert on it without importing Qdrant's TypeScript surface.
 */
export interface QdrantFilterCondition {
	readonly key: string;
	readonly match?: {
		readonly value?: string | number | boolean;
		readonly any?: ReadonlyArray<string | number>;
	};
}

export interface QdrantFilter {
	readonly must?: readonly QdrantFilterCondition[];
	readonly should?: readonly QdrantFilterCondition[];
	readonly must_not?: readonly QdrantFilterCondition[];
}

/**
 * Convert a `VectorFilter` into the Qdrant filter DSL. Returns
 * `undefined` when no filter fields are set so callers can omit the
 * `filter` property entirely (Qdrant treats `{}` differently from
 * "no filter" in some endpoint versions, so we err on the side of
 * omission).
 *
 * Field-by-field mapping:
 *   - `documentId` → `must: [{ key: 'documentId', match: { value } }]`
 *   - `class`      → `must: [{ key: 'class', match: { value } }]`
 *   - `locale`     → `must: [{ key: 'locale', match: { value } }]`
 *   - `tags`       → `must: [{ key: 'tags', match: { any: [...] } }]`
 */
export function buildQdrantFilter(filter?: VectorFilter): QdrantFilter | undefined {
	if (!filter) return undefined;

	const must: QdrantFilterCondition[] = [];

	if (filter.documentId) {
		must.push({ key: 'documentId', match: { value: filter.documentId } });
	}
	if (filter.class) {
		must.push({ key: 'class', match: { value: filter.class } });
	}
	if (filter.locale) {
		must.push({ key: 'locale', match: { value: filter.locale } });
	}
	if (filter.tags && filter.tags.length > 0) {
		must.push({ key: 'tags', match: { any: [...filter.tags] } });
	}

	if (must.length === 0) return undefined;
	return { must };
}
