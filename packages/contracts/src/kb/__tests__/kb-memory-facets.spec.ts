import { describe, expect, it } from 'vitest';
import { KB_DOCUMENT_SOURCES } from '../kb-document-class.js';
import {
	deriveKbMemorySourceBadge,
	KB_MEMORY_CONSOLIDATION_CADENCES,
	KB_MEMORY_CONSOLIDATION_DEFAULT_CADENCE,
	KB_MEMORY_CONSOLIDATION_DEFAULT_MODE,
	KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS,
	KB_MEMORY_CONSOLIDATION_MODES,
	KB_MEMORY_SOURCE_BADGES,
	KB_SYNTHESIS_PATH_PREFIX,
	KB_SYNTHESIS_TAG,
	readKbConnectorSource
} from '../kb-memory-facets.js';

/**
 * Memory facets — badge derivation.
 *
 * These assertions are the whole contract for connector-derived memory
 * being identifiable in the UI: the badge is computed, never stored, so
 * if the derivation is wrong there is no second source of truth to fall
 * back on and every pre-existing row is silently mislabelled.
 */
describe('deriveKbMemorySourceBadge', () => {
	it('labels a user-authored document as human', () => {
		expect(deriveKbMemorySourceBadge({ source: 'user' })).toBe('human');
	});

	it('labels a platform-seeded document as human (it is a shipped default, not agent output)', () => {
		expect(deriveKbMemorySourceBadge({ source: 'seeded' })).toBe('human');
	});

	it('labels an unknown / absent source as human rather than throwing', () => {
		// Total function: an un-stamped legacy row must still render.
		expect(deriveKbMemorySourceBadge({})).toBe('human');
		expect(deriveKbMemorySourceBadge({ source: null })).toBe('human');
	});

	it('labels an agent-written document as agent', () => {
		expect(deriveKbMemorySourceBadge({ source: 'agent' })).toBe('agent');
	});

	it('labels a consolidation-synthesized document as synthesized (via the tag)', () => {
		expect(deriveKbMemorySourceBadge({ source: 'agent', tags: ['synthesis'] })).toBe('synthesized');
	});

	it('labels a consolidation-synthesized document as synthesized (via the stable path)', () => {
		// The tag can be edited off a document; the path cannot, so both
		// markers are honored.
		expect(
			deriveKbMemorySourceBadge({
				source: 'agent',
				path: `${KB_SYNTHESIS_PATH_PREFIX}abc.md`
			})
		).toBe('synthesized');
	});

	it('labels an ingested connector document as connector, whatever its source column says', () => {
		// Ingest provenance wins over `source`: the event-ingest spine
		// writes memory with `source: 'agent'`, and calling that "agent
		// learning" would hide the fact that it came from Slack.
		expect(
			deriveKbMemorySourceBadge({
				source: 'agent',
				metadata: { provenance: { source: 'slack' } }
			})
		).toBe('connector');
	});

	it('labels an imported document as connector (it came from outside the platform)', () => {
		expect(deriveKbMemorySourceBadge({ source: 'imported' })).toBe('connector');
	});

	it('only ever returns a badge from the declared union', () => {
		const inputs = [
			{ source: 'user' },
			{ source: 'agent' },
			{ source: 'agent', tags: ['synthesis'] },
			{ source: 'imported' },
			{ source: 'seeded' },
			{ metadata: { provenance: { source: 'github' } } },
			{}
		];
		for (const input of inputs) {
			expect(KB_MEMORY_SOURCE_BADGES).toContain(deriveKbMemorySourceBadge(input));
		}
	});
});

describe('readKbConnectorSource', () => {
	it('reads the connector name the ingest spine stamped', () => {
		expect(readKbConnectorSource({ metadata: { provenance: { source: 'linear' } } })).toBe('linear');
	});

	it('returns null for a document with no provenance, a malformed one, or a blank source', () => {
		expect(readKbConnectorSource({})).toBeNull();
		expect(readKbConnectorSource({ metadata: {} })).toBeNull();
		expect(readKbConnectorSource({ metadata: { provenance: 'slack' } })).toBeNull();
		expect(readKbConnectorSource({ metadata: { provenance: { source: '   ' } } })).toBeNull();
	});
});

describe('consolidation cadence defaults', () => {
	it('defaults to weekly + dry-run — the cadence never writes unless asked', () => {
		expect(KB_MEMORY_CONSOLIDATION_DEFAULT_CADENCE).toBe('weekly');
		expect(KB_MEMORY_CONSOLIDATION_DEFAULT_MODE).toBe('dry-run');
	});

	it('maps every cadence to a whole-day interval', () => {
		expect(KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS).toEqual({
			daily: 1,
			weekly: 7,
			monthly: 30
		});
	});
});

describe('KB_MEMORY_SOURCE_BADGES', () => {
	it('pins the four badges, most-generic first', () => {
		expect(KB_MEMORY_SOURCE_BADGES).toEqual(['human', 'agent', 'synthesized', 'connector']);
		expect(KB_MEMORY_SOURCE_BADGES).toHaveLength(4);
	});

	it('has no duplicate badges', () => {
		expect(new Set(KB_MEMORY_SOURCE_BADGES).size).toBe(KB_MEMORY_SOURCE_BADGES.length);
	});

	it('is NOT frozen at runtime', () => {
		// `as const` is compile-time only; at runtime this is an ordinary
		// mutable array. Pinned as the CURRENT reality so that adding
		// Object.freeze is a deliberate, reviewed change.
		expect(Object.isFrozen(KB_MEMORY_SOURCE_BADGES)).toBe(false);
	});
});

describe('synthesis markers', () => {
	it('pins the exact path prefix the consolidation pass writes', () => {
		// MemoryConsolidationService.synthesisPath builds paths from this
		// literal and deriveKbMemorySourceBadge reads them back with
		// startsWith. The two only agree because they share this one
		// string — changing it orphans every already-written synthesis
		// document's badge.
		expect(KB_SYNTHESIS_PATH_PREFIX).toBe('memory/synthesis-');
	});

	it('pins the exact tag the consolidation pass attaches', () => {
		expect(KB_SYNTHESIS_TAG).toBe('synthesis');
	});

	it('keeps the prefix rooted under memory/ and open-ended', () => {
		// The trailing hyphen is load-bearing: without it the prefix would
		// also match a hand-written `memory/synthesisation.md`, and the
		// `memory/` root is what keeps synthesis documents out of the class
		// folders (brand/, legal/, …).
		expect(KB_SYNTHESIS_PATH_PREFIX.startsWith('memory/')).toBe(true);
		expect(KB_SYNTHESIS_PATH_PREFIX.endsWith('-')).toBe(true);
		expect(KB_SYNTHESIS_PATH_PREFIX).toContain(KB_SYNTHESIS_TAG);
	});
});

describe('consolidation cadences and modes', () => {
	it('pins the three cadences, shortest interval first', () => {
		expect(KB_MEMORY_CONSOLIDATION_CADENCES).toEqual(['daily', 'weekly', 'monthly']);
		expect(KB_MEMORY_CONSOLIDATION_CADENCES).toHaveLength(3);
		expect(new Set(KB_MEMORY_CONSOLIDATION_CADENCES).size).toBe(3);
	});

	it('pins the two modes, safest first', () => {
		expect(KB_MEMORY_CONSOLIDATION_MODES).toEqual(['dry-run', 'propose']);
		expect(KB_MEMORY_CONSOLIDATION_MODES).toHaveLength(2);
		expect(new Set(KB_MEMORY_CONSOLIDATION_MODES).size).toBe(2);
	});

	it('has no `apply` / `accept` mode — nothing is ever auto-accepted', () => {
		// `propose` is as far as the scheduled pass may go: synthesized
		// documents land as reviewState `proposed` and duplicates are only
		// MARKED superseded. A third mode here would be a policy change.
		expect(KB_MEMORY_CONSOLIDATION_MODES).not.toContain('apply');
		expect(KB_MEMORY_CONSOLIDATION_MODES).not.toContain('accept');
		expect(KB_MEMORY_CONSOLIDATION_MODES).not.toContain('delete');
	});

	it('defaults to members of their own vocabularies, and to the mode that persists nothing', () => {
		// The existing defaults test pins the literals; this one pins the
		// relationship — a default that is not a member of its array would
		// typecheck against the alias but break every <select> built from
		// the array.
		expect(KB_MEMORY_CONSOLIDATION_CADENCES).toContain(KB_MEMORY_CONSOLIDATION_DEFAULT_CADENCE);
		expect(KB_MEMORY_CONSOLIDATION_MODES).toContain(KB_MEMORY_CONSOLIDATION_DEFAULT_MODE);
		expect(KB_MEMORY_CONSOLIDATION_DEFAULT_MODE).toBe(KB_MEMORY_CONSOLIDATION_MODES[0]);
	});

	it('keys the interval record by exactly the cadence list, in the same order', () => {
		// A cadence with no interval entry would make the tick compute
		// `undefined` days and either never fire or fire on every tick.
		expect(Object.keys(KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS)).toEqual([...KB_MEMORY_CONSOLIDATION_CADENCES]);
	});

	it.each([...KB_MEMORY_CONSOLIDATION_CADENCES])('%s maps to a positive whole number of days', (cadence) => {
		const days = KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS[cadence];
		expect(typeof days).toBe('number');
		expect(Number.isInteger(days)).toBe(true);
		expect(days).toBeGreaterThan(0);
	});

	it('orders the intervals strictly ascending, matching the cadence order', () => {
		const intervals = KB_MEMORY_CONSOLIDATION_CADENCES.map(
			(cadence) => KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS[cadence]
		);
		expect(intervals).toEqual([1, 7, 30]);
		for (let i = 1; i < intervals.length; i += 1) {
			expect(intervals[i]).toBeGreaterThan(intervals[i - 1]);
		}
	});

	it('leaves the cadence arrays and the interval record unfrozen at runtime', () => {
		// `Readonly<Record<…>>` on the interval record is a type annotation
		// only — nothing stops a consumer writing to it.
		expect(Object.isFrozen(KB_MEMORY_CONSOLIDATION_CADENCES)).toBe(false);
		expect(Object.isFrozen(KB_MEMORY_CONSOLIDATION_MODES)).toBe(false);
		expect(Object.isFrozen(KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS)).toBe(false);
	});
});

describe('deriveKbMemorySourceBadge — branch and boundary coverage', () => {
	it('ignores synthesis markers on a non-agent document', () => {
		// THE sharpest edge in this function: the synthesis check is NESTED
		// inside `source === 'agent'`, so a human who tags their own note
		// `synthesis`, or files it under memory/synthesis-…, is still
		// badged `human`. Anyone flattening the branches would silently
		// relabel hand-written notes as machine output.
		expect(deriveKbMemorySourceBadge({ source: 'user', tags: [KB_SYNTHESIS_TAG] })).toBe('human');
		expect(deriveKbMemorySourceBadge({ source: 'user', path: `${KB_SYNTHESIS_PATH_PREFIX}x.md` })).toBe('human');
		expect(deriveKbMemorySourceBadge({ source: 'seeded', tags: [KB_SYNTHESIS_TAG] })).toBe('human');
	});

	it('lets ingest provenance outrank even a human source column', () => {
		// Rule 1 runs before the `source` checks: whatever wrote the row,
		// a document that arrived off a connector event is `connector`.
		expect(
			deriveKbMemorySourceBadge({
				source: 'user',
				metadata: { provenance: { source: 'slack' } }
			})
		).toBe('connector');
	});

	it('badges an imported document with provenance as connector by the FIRST rule', () => {
		// Both rule 1 and rule 2 would return `connector` here; the test
		// exists so that removing either one does not look harmless.
		expect(
			deriveKbMemorySourceBadge({
				source: 'imported',
				metadata: { provenance: { source: 'notion' } }
			})
		).toBe('connector');
	});

	it('lets `imported` outrank a synthesis marker', () => {
		expect(deriveKbMemorySourceBadge({ source: 'imported', tags: [KB_SYNTHESIS_TAG] })).toBe('connector');
	});

	it('falls back to agent when the provenance source is blank', () => {
		// readKbConnectorSource returns null for a whitespace-only name, so
		// rule 1 does not fire and the agent branch takes over.
		expect(
			deriveKbMemorySourceBadge({
				source: 'agent',
				metadata: { provenance: { source: '   ' } }
			})
		).toBe('agent');
	});

	it.each([
		['an empty tag list', { source: 'agent', tags: [] }],
		['null tags and a null path', { source: 'agent', tags: null, path: null }],
		['an absent path and absent tags', { source: 'agent' }]
	])('badges an agent document with %s as agent (the ?? defaults hold)', (_label, input) => {
		expect(deriveKbMemorySourceBadge(input)).toBe('agent');
	});

	it('matches the synthesis path as a PREFIX, not anywhere in the path', () => {
		// `startsWith`, not `includes`: a document nested under
		// kb/memory/synthesis-… was not written by the consolidation pass.
		expect(deriveKbMemorySourceBadge({ source: 'agent', path: `kb/${KB_SYNTHESIS_PATH_PREFIX}x.md` })).toBe(
			'agent'
		);
		expect(deriveKbMemorySourceBadge({ source: 'agent', path: `x-${KB_SYNTHESIS_PATH_PREFIX}x.md` })).toBe('agent');
	});

	it('treats the bare prefix with an empty suffix as synthesized (boundary)', () => {
		expect(deriveKbMemorySourceBadge({ source: 'agent', path: KB_SYNTHESIS_PATH_PREFIX })).toBe('synthesized');
	});

	it('matches the synthesis tag by exact equality, not by prefix', () => {
		expect(deriveKbMemorySourceBadge({ source: 'agent', tags: ['synthesis-notes'] })).toBe('agent');
		expect(deriveKbMemorySourceBadge({ source: 'agent', tags: ['Synthesis'] })).toBe('agent');
		// …but position in the list does not matter.
		expect(deriveKbMemorySourceBadge({ source: 'agent', tags: ['weekly', KB_SYNTHESIS_TAG] })).toBe('synthesized');
	});

	it('compares the source column case-sensitively', () => {
		// An upper-cased source is an unknown value and therefore `human`,
		// per the documented rule 5 fallback.
		expect(deriveKbMemorySourceBadge({ source: 'AGENT' })).toBe('human');
		expect(deriveKbMemorySourceBadge({ source: 'Imported' })).toBe('human');
	});

	it.each([
		['user', 'human'],
		['agent', 'agent'],
		['imported', 'connector'],
		['seeded', 'human']
	])('badges a plain %s document as %s', (source, badge) => {
		// Matrix over the FULL KB_DOCUMENT_SOURCES vocabulary: the
		// derivation must be total over every value the column can hold,
		// and this breaks if a source is added there without a rule here.
		expect(KB_DOCUMENT_SOURCES).toContain(source);
		expect(deriveKbMemorySourceBadge({ source })).toBe(badge);
	});

	it('covers every KB_DOCUMENT_SOURCES member with a case above', () => {
		expect(KB_DOCUMENT_SOURCES).toHaveLength(4);
	});
});

describe('readKbConnectorSource — branch and boundary coverage', () => {
	it('trims the stamped connector name', () => {
		expect(readKbConnectorSource({ metadata: { provenance: { source: '  slack  ' } } })).toBe('slack');
		expect(readKbConnectorSource({ metadata: { provenance: { source: '\n\tgithub\t' } } })).toBe('github');
	});

	it('ignores sibling provenance fields', () => {
		expect(readKbConnectorSource({ metadata: { provenance: { source: 'zoom', channel: 'general' } } })).toBe(
			'zoom'
		);
	});

	it.each([
		['metadata is null', { metadata: null }],
		['metadata is undefined', { metadata: undefined }],
		['provenance is null', { metadata: { provenance: null } }],
		['provenance is undefined', { metadata: { provenance: undefined } }],
		['provenance is an array', { metadata: { provenance: [] } }],
		['provenance is a number', { metadata: { provenance: 7 } }],
		['provenance has no source', { metadata: { provenance: {} } }]
	])('returns null when %s', (_label, input) => {
		// `typeof null === 'object'`, so the leading `!provenance` check is
		// the only thing keeping the null case from throwing on `.source`.
		expect(readKbConnectorSource(input)).toBeNull();
	});

	it.each([
		['a number', 42],
		['a boolean', true],
		['an object', {}],
		['an array', ['slack']],
		['null', null],
		['a tab-and-newline blank', '\t\n ']
	])('returns null when provenance.source is %s', (_label, source) => {
		expect(readKbConnectorSource({ metadata: { provenance: { source } } })).toBeNull();
	});

	it('does not mutate the input document', () => {
		// Pure read: the badge derivation calls this on every rendered row.
		const input = { source: 'agent', metadata: { provenance: { source: '  slack  ' } } };
		const snapshot = structuredClone(input);
		readKbConnectorSource(input);
		expect(input).toEqual(snapshot);
	});
});
