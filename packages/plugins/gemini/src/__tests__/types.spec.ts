import { describe, it, expect } from 'vitest';
import { DEFAULT_CLI_VERSION } from '../types';
import { ensureBinary } from '../utils/binary-manager';

describe('types — DEFAULT_CLI_VERSION (EW-720 supply-chain pin)', () => {
	// Blocked/sanitised case: the default must be an EXACT semver — never the
	// `latest` (or any) dist-tag, range, or other floating spec that would
	// auto-fetch an unreviewed Gemini CLI release via npx.
	it('is pinned to an exact x.y.z semver (no dist-tag / range)', () => {
		expect(DEFAULT_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(DEFAULT_CLI_VERSION).not.toBe('latest');
	});

	// Legit happy path: the pinned default is a value the binary-manager accepts,
	// and resolves to a version-suffixed package spec (not the floating tag).
	it('is accepted by the binary-manager and yields a version-pinned spec', () => {
		const result = ensureBinary(DEFAULT_CLI_VERSION);

		expect(result).toEqual({
			command: 'npx',
			args: ['--yes', `@google/gemini-cli@${DEFAULT_CLI_VERSION}`]
		});
	});

	// The `latest` sentinel stays supported as an explicit opt-in (only the
	// DEFAULT changed); the binary-manager still treats it specially.
	it('still supports the explicit "latest" opt-in via the binary-manager', () => {
		const result = ensureBinary('latest');

		expect(result).toEqual({
			command: 'npx',
			args: ['--yes', '@google/gemini-cli']
		});
	});
});
