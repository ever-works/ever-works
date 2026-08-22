import { describe, expect, it } from 'vitest';

import * as kb from '../index.js';
import { KB_DOCUMENT_CLASSES, KB_ORG_INHERITABLE_CLASSES } from '../kb-document-class.js';
import {
	deriveKbMemorySourceBadge,
	KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS,
	readKbConnectorSource
} from '../kb-memory-facets.js';

/**
 * The kb barrel is ten `export *` lines and nothing of its own. Eight of
 * the ten sources are 100% type-only, so this list IS the entire runtime
 * surface of `@ever-works/contracts` kb — a dropped, renamed or reordered
 * `export *` line silently breaks every downstream `import { KB_… }` and
 * nothing else in the package would notice.
 */
const EXPECTED_RUNTIME_EXPORTS = [
	'KB_CITATION_CONSUMER_TYPES',
	'KB_DECISION_STATUSES',
	'KB_DOCUMENT_CLASSES',
	'KB_DOCUMENT_SOURCES',
	'KB_DOCUMENT_STATUSES',
	'KB_LOCK_MODES',
	'KB_MEMORY_CONSOLIDATION_CADENCES',
	'KB_MEMORY_CONSOLIDATION_DEFAULT_CADENCE',
	'KB_MEMORY_CONSOLIDATION_DEFAULT_MODE',
	'KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS',
	'KB_MEMORY_CONSOLIDATION_MODES',
	'KB_MEMORY_SOURCE_BADGES',
	'KB_ORG_INHERITABLE_CLASSES',
	'KB_REVIEW_STATES',
	'KB_SYNTHESIS_PATH_PREFIX',
	'KB_SYNTHESIS_TAG',
	'KB_UPLOAD_EXTRACTION_STATUSES',
	'deriveKbMemorySourceBadge',
	'readKbConnectorSource'
];

describe('kb barrel', () => {
	it('re-exports exactly the nineteen runtime names', () => {
		expect(Object.keys(kb).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
	});

	it('exposes nineteen runtime keys — tripwire for a silent addition', () => {
		// Asserted separately from the name list so an accidental new
		// export shows up as a count change even if someone updates the
		// list above without thinking about it.
		expect(Object.keys(kb)).toHaveLength(19);
	});

	it('contributes no runtime keys from the eight type-only modules', () => {
		// kb-document.types / kb-citation.types / kb-context-bundle.types /
		// kb-search.types / kb-tag.types / kb-tree.types / kb-upload.types /
		// decision-conflict.types are interfaces and type aliases only. If a
		// const ever lands in one of them this count moves and the author is
		// forced to add a spec for it.
		const fromDocumentClass = 9;
		const fromMemoryFacets = 10;
		expect(Object.keys(kb)).toHaveLength(fromDocumentClass + fromMemoryFacets);
	});

	it('has no default export', () => {
		// The package is ESM named-exports only; a default would break the
		// `export *` barrel above it (default is not re-exported by `*`).
		expect(Object.keys(kb)).not.toContain('default');
		expect((kb as Record<string, unknown>).default).toBeUndefined();
	});

	it('names every export either KB_* or a kb-prefixed camelCase helper', () => {
		for (const name of Object.keys(kb)) {
			expect(name).toMatch(/^(KB_[A-Z0-9_]+|(derive|read)Kb[A-Za-z]+)$/);
		}
	});

	it('re-exports the identical binding, never a copy', () => {
		// `toBe`, not `toEqual`: a barrel that wrapped or cloned a value
		// would break `===` checks and, for the arrays, silently give
		// consumers a second instance to mutate.
		expect(kb.KB_DOCUMENT_CLASSES).toBe(KB_DOCUMENT_CLASSES);
		expect(kb.KB_ORG_INHERITABLE_CLASSES).toBe(KB_ORG_INHERITABLE_CLASSES);
		expect(kb.KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS).toBe(KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS);
		expect(kb.deriveKbMemorySourceBadge).toBe(deriveKbMemorySourceBadge);
		expect(kb.readKbConnectorSource).toBe(readKbConnectorSource);
	});

	it('exposes both memory-facet helpers as unary functions', () => {
		expect(typeof kb.deriveKbMemorySourceBadge).toBe('function');
		expect(typeof kb.readKbConnectorSource).toBe('function');
		// Arity is part of the contract: both take exactly one document-ish
		// object and neither accepts an options bag.
		expect(kb.deriveKbMemorySourceBadge.length).toBe(1);
		expect(kb.readKbConnectorSource.length).toBe(1);
	});

	it('exposes every KB_*_ES / KB_*_S vocabulary as a non-empty array', () => {
		const arrays = Object.entries(kb).filter(([, value]) => Array.isArray(value));
		// 9 from kb-document-class + KB_MEMORY_SOURCE_BADGES +
		// KB_MEMORY_CONSOLIDATION_CADENCES + KB_MEMORY_CONSOLIDATION_MODES.
		expect(arrays).toHaveLength(12);
		for (const [name, value] of arrays) {
			expect(name.startsWith('KB_')).toBe(true);
			expect((value as unknown[]).length).toBeGreaterThan(0);
		}
	});

	it('carries the two string literals and the one record through unchanged', () => {
		expect(kb.KB_SYNTHESIS_PATH_PREFIX).toBe('memory/synthesis-');
		expect(kb.KB_SYNTHESIS_TAG).toBe('synthesis');
		expect(kb.KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS).toEqual({ daily: 1, weekly: 7, monthly: 30 });
	});
});
