import { describe, expect, it } from 'vitest';

import { authModeForEnv, resolveAuthEnv, resolveAuthMode } from '../utils/pipeline-helpers.js';

describe('resolveAuthMode', () => {
	it('recognizes the two supported modes', () => {
		expect(resolveAuthMode({ authMode: 'subscription' })).toBe('subscription');
		expect(resolveAuthMode({ authMode: 'api-key' })).toBe('api-key');
	});

	it('treats an unset or unknown mode as unpinned', () => {
		expect(resolveAuthMode({})).toBeUndefined();
		expect(resolveAuthMode({ authMode: 'bedrock' })).toBeUndefined();
	});
});

describe('resolveAuthEnv', () => {
	it('keeps the legacy inference when no mode is pinned', () => {
		expect(resolveAuthEnv({ oauthToken: 'oauth', apiKey: 'sk-key' })).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: 'oauth'
		});
		expect(resolveAuthEnv({ apiKey: 'sk-key' })).toEqual({ ANTHROPIC_API_KEY: 'sk-key' });
		expect(resolveAuthEnv({})).toEqual({});
	});

	it('resolves a pinned subscription agent to the OAuth token only', () => {
		expect(
			resolveAuthEnv({
				authMode: 'subscription',
				oauthToken: 'oauth',
				apiKey: 'sk-key'
			})
		).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
	});

	it('never degrades a subscription agent into per-token API billing', () => {
		// The whole point of pinning: an operator who chose their Claude plan must
		// not get a Console invoice because an API key happened to be configured.
		expect(
			resolveAuthEnv({
				authMode: 'subscription',
				apiKey: 'sk-should-not-be-used'
			})
		).toEqual({});
	});

	it('resolves a pinned api-key agent to the API key only', () => {
		expect(
			resolveAuthEnv({
				authMode: 'api-key',
				oauthToken: 'oauth',
				apiKey: 'sk-key'
			})
		).toEqual({ ANTHROPIC_API_KEY: 'sk-key' });
	});

	it('falls back from a keyless api-key agent to the subscription token', () => {
		// Falling this direction costs plan quota rather than money, so it is the
		// safe degradation — unlike the reverse, which is blocked above.
		expect(
			resolveAuthEnv({
				authMode: 'api-key',
				oauthToken: 'oauth'
			})
		).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
	});
});

describe('authModeForEnv', () => {
	it('reports which credential actually served the run', () => {
		expect(authModeForEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })).toBe('subscription');
		expect(authModeForEnv({ ANTHROPIC_API_KEY: 'sk-key' })).toBe('api-key');
		expect(authModeForEnv({})).toBeUndefined();
	});
});
