import { describe, expect, it } from 'vitest';

import { DEFAULT_WORKSPACE_PATH, WORKSPACE_SEED_MANIFEST_MOUNT_PATH } from '../types.js';
import { attachedEnvFileMountPath, attachedRepoMountPath, buildSessionResources } from './session-resources.js';

const SEED = { fileId: 'file_seed_1', mountPath: WORKSPACE_SEED_MANIFEST_MOUNT_PATH };

describe('buildSessionResources', () => {
	it('is byte-stable with no attachments (exactly the historic seed-manifest payload)', () => {
		const resources = buildSessionResources({
			workspacePath: DEFAULT_WORKSPACE_PATH,
			seedManifest: SEED
		});

		expect(JSON.stringify(resources)).toBe(
			JSON.stringify([
				{
					type: 'file',
					file_id: 'file_seed_1',
					mount_path: WORKSPACE_SEED_MANIFEST_MOUNT_PATH
				}
			])
		);
	});

	it('treats an empty attachments list identically to an absent one', () => {
		const withEmpty = buildSessionResources({
			workspacePath: DEFAULT_WORKSPACE_PATH,
			seedManifest: SEED,
			attachedRepos: [],
			uploadedEnvFiles: []
		});
		const withAbsent = buildSessionResources({
			workspacePath: DEFAULT_WORKSPACE_PATH,
			seedManifest: SEED
		});

		expect(withEmpty).toEqual(withAbsent);
	});

	it('appends one github_repository resource per attached repo, after the seed manifest', () => {
		const resources = buildSessionResources({
			workspacePath: '/workspace',
			seedManifest: SEED,
			attachedRepos: [
				{ url: 'https://github.com/acme/api', branch: 'develop', mountDir: 'api' },
				{ url: 'https://github.com/acme/web', mountDir: 'web' }
			]
		});

		expect(resources).toHaveLength(3);
		expect(resources[0].type).toBe('file');
		expect(resources[1]).toEqual({
			type: 'github_repository',
			url: 'https://github.com/acme/api',
			mount_path: '/workspace/api',
			branch: 'develop'
		});
		// No branch key at all when the repo has no branch (payload hygiene).
		expect(resources[2]).toEqual({
			type: 'github_repository',
			url: 'https://github.com/acme/web',
			mount_path: '/workspace/web'
		});
		expect(Object.keys(resources[2])).not.toContain('branch');
	});

	it('mounts uploaded env files under their repo directory', () => {
		const resources = buildSessionResources({
			workspacePath: '/workspace',
			seedManifest: SEED,
			attachedRepos: [{ url: 'https://github.com/acme/api', mountDir: 'api' }],
			uploadedEnvFiles: [
				{ fileId: 'file_env_1', mountDir: 'api', path: '.env' },
				{ fileId: 'file_env_2', mountDir: 'api', path: 'config/.env.local' }
			]
		});

		expect(resources.slice(2)).toEqual([
			{ type: 'file', file_id: 'file_env_1', mount_path: '/workspace/api/.env' },
			{
				type: 'file',
				file_id: 'file_env_2',
				mount_path: '/workspace/api/config/.env.local'
			}
		]);
	});
});

describe('mount path helpers', () => {
	it('normalizes trailing and leading slashes', () => {
		expect(attachedRepoMountPath('/workspace/', 'api')).toBe('/workspace/api');
		expect(attachedEnvFileMountPath('/workspace', 'api', '/.env')).toBe('/workspace/api/.env');
	});
});
