import * as fs from 'fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiProviderConfig } from '@ever-works/plugin';
import { cleanupOpenCodeSessionConfig, prepareOpenCodeSessionConfig } from '../utils/opencode-config';

const createdSessionDirs: string[] = [];

const providerConfig: AiProviderConfig = {
	providerId: 'test-provider',
	providerName: 'Test Provider',
	baseUrl: 'https://example.com/v1',
	apiKey: 'provider-key',
	defaultModel: 'gemini-2.5-flash',
	routing: {}
};

describe('opencode-config', () => {
	afterEach(async () => {
		await Promise.all(createdSessionDirs.splice(0).map((sessionDir) => cleanupOpenCodeSessionConfig(sessionDir)));
	});

	it('writes model identifiers in provider/model format for the generated OpenCode config', async () => {
		const session = await prepareOpenCodeSessionConfig({
			userId: 'user-1',
			directoryId: 'dir-1',
			providerConfig,
			model: 'gemini-2.5-flash'
		});
		createdSessionDirs.push(session.sessionDir);

		const configPath = `${session.configDir}/opencode.json`;
		const config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as {
			model: string;
			small_model: string;
			provider: Record<string, { options: { apiKey: string } }>;
		};

		expect(session.model).toBe('everworks/gemini-2.5-flash');
		expect(config.model).toBe('everworks/gemini-2.5-flash');
		expect(config.small_model).toBe('everworks/gemini-2.5-flash');
		expect(config.provider.everworks.options.apiKey).toBe('{env:OPENCODE_PROVIDER_API_KEY}');
	});
});
