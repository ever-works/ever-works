import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { AGENT_INIT_SCRIPT_MAX_BYTES } from '../agent-capabilities.types.js';

// Everything else this module exports (AgentToolSource, AgentToolCatalogEntry,
// AgentCapabilityToolRow, AgentStoredToolGrant, AgentCapabilitiesPayload) is
// type-only and has no runtime footprint, so there is nothing to assert on it.

describe('AGENT_INIT_SCRIPT_MAX_BYTES', () => {
	it('is 16384', () => {
		expect(AGENT_INIT_SCRIPT_MAX_BYTES).toBe(16384);
	});

	it('is exactly 16 KiB expressed as bytes', () => {
		// Asserted a second way on purpose: a units mix-up (16, 16_000, 16 MB)
		// still produces a plausible-looking number, but not this product.
		expect(AGENT_INIT_SCRIPT_MAX_BYTES).toBe(16 * 1024);
	});

	it('is a positive integer', () => {
		expect(typeof AGENT_INIT_SCRIPT_MAX_BYTES).toBe('number');
		expect(Number.isInteger(AGENT_INIT_SCRIPT_MAX_BYTES)).toBe(true);
		// A zero or negative cap would silently forbid every init script.
		expect(AGENT_INIT_SCRIPT_MAX_BYTES).toBeGreaterThan(0);
	});

	it('divides evenly into whole kibibytes', () => {
		// The user-facing error message renders `cap / 1024` as a KB figure, so a
		// cap that stops dividing evenly would start printing '15.625 KB'.
		expect(AGENT_INIT_SCRIPT_MAX_BYTES / 1024).toBe(16);
		expect(AGENT_INIT_SCRIPT_MAX_BYTES % 1024).toBe(0);
	});
});

describe('AGENT_INIT_SCRIPT_MAX_BYTES — the boundary the consumer enforces', () => {
	// The service compares `bytes > AGENT_INIT_SCRIPT_MAX_BYTES`, i.e. STRICTLY
	// greater, so a script sitting exactly ON the cap is ALLOWED. Classic
	// off-by-one; all three neighbours are pinned.
	const exceedsCap = (script: string): boolean => Buffer.byteLength(script, 'utf8') > AGENT_INIT_SCRIPT_MAX_BYTES;

	it.each([
		[16383, false],
		[16384, false],
		[16385, true]
	] as [number, boolean][])('a %d-byte ASCII script exceeds the cap: %s', (bytes, expected) => {
		const script = 'a'.repeat(bytes);
		expect(Buffer.byteLength(script, 'utf8')).toBe(bytes);
		expect(exceedsCap(script)).toBe(expected);
	});

	it('accepts an empty init script', () => {
		expect(exceedsCap('')).toBe(false);
	});

	it('counts BYTES, not UTF-16 code units', () => {
		// 8192 two-byte characters are exactly at the cap by bytes, but only 8192
		// units long. The DTO's @MaxLength counts UTF-16 units, so the two agree
		// only for ASCII — a multi-byte script is effectively allowed more bytes
		// than the constant's name implies. Concrete demonstration of that gap.
		const twoByteChars = 'é'.repeat(8192);
		expect(twoByteChars).toHaveLength(8192);
		expect(Buffer.byteLength(twoByteChars, 'utf8')).toBe(AGENT_INIT_SCRIPT_MAX_BYTES);
		expect(exceedsCap(twoByteChars)).toBe(false);
	});

	it('rejects one two-byte character past the cap', () => {
		const overCap = 'é'.repeat(8193);
		expect(Buffer.byteLength(overCap, 'utf8')).toBe(AGENT_INIT_SCRIPT_MAX_BYTES + 2);
		expect(exceedsCap(overCap)).toBe(true);
	});
});
