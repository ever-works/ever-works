import { describe, expect, it } from 'vitest';
import {
	deriveKbMemorySourceBadge,
	KB_MEMORY_CONSOLIDATION_DEFAULT_CADENCE,
	KB_MEMORY_CONSOLIDATION_DEFAULT_MODE,
	KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS,
	KB_MEMORY_SOURCE_BADGES,
	KB_SYNTHESIS_PATH_PREFIX,
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
		expect(deriveKbMemorySourceBadge({ source: 'agent', tags: ['synthesis'] })).toBe(
			'synthesized'
		);
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
		expect(readKbConnectorSource({ metadata: { provenance: { source: 'linear' } } })).toBe(
			'linear'
		);
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
