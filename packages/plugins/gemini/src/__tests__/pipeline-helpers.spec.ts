import { describe, it, expect } from 'vitest';
import { resolveAuthEnv } from '../utils/pipeline-helpers';

describe('pipeline-helpers', () => {
	describe('resolveAuthEnv', () => {
		it('should omit masked secrets from runtime environment', () => {
			expect(
				resolveAuthEnv({
					authMode: 'api-key',
					apiKey: '••••••••'
				})
			).toEqual({});

			expect(
				resolveAuthEnv({
					authMode: 'vertex',
					googleCloudProject: 'ever-works',
					googleCloudLocation: 'us-central1'
				})
			).toEqual({
				GOOGLE_GENAI_USE_VERTEXAI: 'true',
				GOOGLE_CLOUD_PROJECT: 'ever-works',
				GOOGLE_CLOUD_LOCATION: 'us-central1'
			});
		});

		it('should expose usable auth values', () => {
			expect(
				resolveAuthEnv({
					authMode: 'api-key',
					apiKey: 'test-key'
				})
			).toEqual({ GEMINI_API_KEY: 'test-key' });
		});
	});
});
