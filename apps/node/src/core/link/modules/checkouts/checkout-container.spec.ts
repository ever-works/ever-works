import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containerRefusal, containerRunArgv, isContainerImageReference } from './checkout-container';
import type { CheckoutGitRunner } from './checkout-git';
import { linkSharedFolders } from './checkout-shared-folders';

describe('container isolation (FL-14 P3, spec FR-31, U11, ACC-FL14-20)', () => {
	it('is refused on Windows and without Docker, naming the missing piece', () => {
		expect(containerRefusal('win32', true)).toMatch(/Windows/);
		expect(containerRefusal('linux', false)).toMatch(/Docker/);
		expect(containerRefusal('linux', true)).toBeNull();
	});

	it('mounts the folder at /workspace and runs the command there, argv only', () => {
		expect(
			containerRunArgv({ path: '/srv/checkouts/api/fix', image: 'node:22-bookworm', command: ['bash', '-l'], tty: true })
		).toEqual([
			'docker',
			'run',
			'--rm',
			'-i',
			'-t',
			'-v',
			'/srv/checkouts/api/fix:/workspace',
			'-w',
			'/workspace',
			'node:22-bookworm',
			'bash',
			'-l'
		]);
	});

	it('refuses an image that could be read as an option or a shell fragment', () => {
		expect(isContainerImageReference('--privileged')).toBe(false);
		expect(isContainerImageReference('node:22 ; rm -rf /')).toBe(false);
		expect(isContainerImageReference('ghcr.io/acme/dev@sha256:abc')).toBe(true);
	});
});

describe('shared folders (FL-14 P3, spec FR-32, ACC-FL14-28)', () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'fl14-shared-'));
		await mkdir(join(root, 'parent', 'node_modules'), { recursive: true });
		await mkdir(join(root, 'parent', 'src'), { recursive: true });
		await writeFile(join(root, 'parent', '.env.local'), 'X=1');
		await mkdir(join(root, 'tree'), { recursive: true });
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const git: CheckoutGitRunner = async (args) =>
		args[0] === 'check-ignore' && (args[3] === 'node_modules' || args[3] === '.env.local')
			? { code: 0, stdout: '', stderr: '' }
			: { code: 1, stdout: '', stderr: '' };

	it('links ignored folders, never copies, and skips tracked, missing and escaping ones', async () => {
		const outcomes = await linkSharedFolders(
			{
				parentPath: join(root, 'parent'),
				worktreePath: join(root, 'tree'),
				folders: ['node_modules', 'src', 'missing', '../outside', '.git'],
				platform: process.platform
			},
			git
		);
		expect(outcomes).toEqual([
			{ folder: 'node_modules', linked: true },
			{ folder: 'src', linked: false, reason: 'tracked' },
			{ folder: 'missing', linked: false, reason: 'missing' },
			{ folder: '../outside', linked: false, reason: 'invalid' },
			{ folder: '.git', linked: false, reason: 'invalid' }
		]);
		expect(await readlink(join(root, 'tree', 'node_modules'))).toContain('node_modules');
	});
});
