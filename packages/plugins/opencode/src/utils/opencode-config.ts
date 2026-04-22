import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { AiProviderConfig } from '@ever-works/plugin';
import { BASE_TEMP_DIR } from '../types.js';

const OPENCODE_PROVIDER_ID = 'everworks';

export interface OpenCodeSessionConfig {
	readonly sessionDir: string;
	readonly configDir: string;
	readonly env: Record<string, string>;
}

function getSessionRoot(userId: string, directoryId: string): string {
	return path.join(BASE_TEMP_DIR, userId, 'opencode', directoryId);
}

function buildConfig(providerConfig: AiProviderConfig, model: string) {
	const qualifiedModel = `${OPENCODE_PROVIDER_ID}/${model}`;

	return {
		$schema: 'https://opencode.ai/config.json',
		model: qualifiedModel,
		small_model: qualifiedModel,
		enabled_providers: [OPENCODE_PROVIDER_ID],
		provider: {
			[OPENCODE_PROVIDER_ID]: {
				npm: '@ai-sdk/openai-compatible',
				name: providerConfig.providerName || providerConfig.providerId,
				options: {
					baseURL: providerConfig.baseUrl,
					apiKey: '{env:OPENCODE_PROVIDER_API_KEY}'
				},
				models: {
					[model]: {
						name: model
					}
				}
			}
		},
		permission: {
			bash: 'deny',
			question: 'deny',
			skill: 'deny',
			todowrite: 'deny',
			lsp: 'deny',
			read: 'allow',
			edit: 'allow',
			grep: 'allow',
			glob: 'allow',
			webfetch: 'allow',
			websearch: 'allow'
		}
	};
}

export async function prepareOpenCodeSessionConfig(options: {
	userId: string;
	directoryId: string;
	providerConfig: AiProviderConfig;
	model: string;
}): Promise<OpenCodeSessionConfig> {
	const { userId, directoryId, providerConfig, model } = options;
	const sessionRoot = getSessionRoot(userId, directoryId);
	await fs.mkdir(sessionRoot, { recursive: true });
	const sessionDir = path.join(sessionRoot, `run-${randomUUID()}`);
	const configDir = path.join(sessionDir, 'config');
	const dataHome = path.join(sessionDir, 'data');

	await fs.mkdir(configDir, { recursive: true });
	await fs.mkdir(path.join(dataHome, 'opencode'), { recursive: true });

	const config = buildConfig(providerConfig, model);
	await fs.writeFile(path.join(configDir, 'opencode.json'), JSON.stringify(config, null, 2), 'utf-8');

	return {
		sessionDir,
		configDir,
		env: {
			HOME: sessionDir,
			XDG_DATA_HOME: dataHome,
			OPENCODE_CONFIG_DIR: configDir,
			OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
			OPENCODE_PROVIDER_API_KEY: providerConfig.apiKey || '',
			OPENCODE_ENABLE_EXA: '1',
			OPENCODE_DISABLE_AUTOUPDATE: '1'
		}
	};
}

export async function cleanupOpenCodeSessionConfig(sessionDir: string): Promise<void> {
	try {
		await fs.rm(sessionDir, { recursive: true, force: true });
	} catch {
		// Cleanup failures are non-fatal
	}
}
