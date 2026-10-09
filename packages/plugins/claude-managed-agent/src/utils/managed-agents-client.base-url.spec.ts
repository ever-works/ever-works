import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The base URL `AnthropicManagedAgentsClient` hands the SDK. The SDK is mocked only to capture
 * the options it is constructed with.
 */
const constructedWith: Array<{ baseURL?: string }> = [];

vi.mock('@anthropic-ai/sdk', () => {
	class AnthropicMock {
		constructor(options: { baseURL?: string }) {
			constructedWith.push(options);
		}
	}
	return { default: AnthropicMock, toFile: vi.fn() };
});

import { DEFAULT_BASE_URL } from '../types.js';
import { AnthropicManagedAgentsClient } from './managed-agents-client.js';

function baseUrlFor(baseUrl: string | undefined): string | undefined {
	new AnthropicManagedAgentsClient('test-key', baseUrl);
	return constructedWith.at(-1)?.baseURL;
}

describe('AnthropicManagedAgentsClient — base URL normalisation', () => {
	beforeEach(() => {
		constructedWith.length = 0;
	});

	/**
	 * CodeQL js/polynomial-redos. Trailing slashes used to be stripped with `/\/+$/`, which
	 * backtracks quadratically over a run of `/` that is not at the end: every `/` restarts a
	 * scan to the end of the run (50 000 of them took ~2.4 s). `baseUrl` is a plugin setting.
	 */
	it('normalises a base URL with a long inner run of "/" in linear time', () => {
		const hostile = `https://api.example.com${'/'.repeat(50_000)}x`;

		const started = performance.now();
		const baseURL = baseUrlFor(hostile);
		const elapsedMs = performance.now() - started;

		expect(baseURL).toBe(hostile);
		expect(elapsedMs).toBeLessThan(200);
	});

	// The rewrite must answer exactly what the two regexes answered.
	it.each([
		['https://api.anthropic.com', 'https://api.anthropic.com'],
		['https://api.anthropic.com/', 'https://api.anthropic.com'],
		['https://api.anthropic.com/v1', 'https://api.anthropic.com'],
		['https://api.anthropic.com/v1/', 'https://api.anthropic.com'],
		['  https://proxy.example.com/anthropic/v1  ', 'https://proxy.example.com/anthropic'],
		['https://proxy.example.com///', 'https://proxy.example.com'],
		['https://proxy.example.com/v1//', 'https://proxy.example.com/v1'],
		['https://proxy.example.com/v1/v1', 'https://proxy.example.com/v1'],
		['https://proxy.example.com/v10', 'https://proxy.example.com/v10'],
		['https://proxy.example.com/api/v1/x', 'https://proxy.example.com/api/v1/x'],
		['/v1', ''],
		['   ', DEFAULT_BASE_URL]
	])('normalises %j to %j', (input, expected) => {
		expect(baseUrlFor(input)).toBe(expected);
	});

	it('falls back to the default base URL when none is given', () => {
		expect(baseUrlFor(undefined)).toBe(DEFAULT_BASE_URL);
	});
});
