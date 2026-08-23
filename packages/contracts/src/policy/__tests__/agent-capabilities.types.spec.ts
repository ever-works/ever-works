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

describe('AGENT_INIT_SCRIPT_MAX_BYTES — what the value means', () => {
	// The cap is named BYTES, and the enforcing service compares
	// `Buffer.byteLength(script) > AGENT_INIT_SCRIPT_MAX_BYTES`. The comparison
	// itself lives in that service and is tested there — re-implementing it here
	// would only test the local lambda. What IS a property of the constant is
	// where the byte cap lands relative to the DTO's `@MaxLength`, which counts
	// UTF-16 code units: the two agree only for ASCII.
	it('sits exactly at 8192 two-byte characters, half of what @MaxLength would allow', () => {
		const twoByteChars = 'é'.repeat(8192);
		expect(twoByteChars).toHaveLength(8192);
		expect(Buffer.byteLength(twoByteChars, 'utf8')).toBe(AGENT_INIT_SCRIPT_MAX_BYTES);
	});

	it('is reached by exactly 16384 ASCII characters', () => {
		expect(Buffer.byteLength('a'.repeat(AGENT_INIT_SCRIPT_MAX_BYTES), 'utf8')).toBe(AGENT_INIT_SCRIPT_MAX_BYTES);
	});
});
