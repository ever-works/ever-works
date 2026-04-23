import { describe, it, expect } from 'vitest';
import { resolveAuthEnv } from '../utils/pipeline-helpers';

describe('pipeline-helpers', () => {
	describe('resolveAuthEnv', () => {
		it('should omit masked secrets from runtime environment', () => {
			expect(
				resolveAuthEnv({
					apiKey: '••••••••'
				})
			).toEqual({});
		});

		it('should expose usable auth values', () => {
			expect(
				resolveAuthEnv({
					apiKey: 'test-key'
				})
			).toEqual({ GEMINI_API_KEY: 'test-key' });
		});
	});
});
