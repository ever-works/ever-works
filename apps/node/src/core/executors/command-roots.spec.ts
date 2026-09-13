import { describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRootError, resolveCommandRoot } from './command-roots';

/**
 * The gate between an attacker-influenceable NAME and a directory a shell
 * runs in on one of six PCs holding the owner's credentials.
 *
 * Everything here uses a REAL directory tree with REAL junctions, because
 * the properties under test are filesystem properties: a junction is not a
 * directory, a `realpath` is not the path you gave it, and a lookup is not
 * a join. A test that stubbed `lstat` would prove only that the stub
 * matches the assertion.
 */

/** A fleet-root-shaped layout: primary and mounts are SIBLINGS, not nested. */
async function fleetLayout(): Promise<{
	root: string;
	primary: string;
	apiMount: string;
	outside: string;
}> {
	const root = mkdtempSync(join(tmpdir(), 'ew-cmd-root-'));
	const primary = join(root, 'primary');
	const apiMount = join(root, 'api-mount');
	const outside = join(root, 'outside');
	await fs.mkdir(join(primary, '.mounts'), { recursive: true });
	await fs.mkdir(apiMount, { recursive: true });
	await fs.mkdir(outside, { recursive: true });
	return { root, primary, apiMount, outside };
}

const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

describe('resolveCommandRoot — no mount named', () => {
	it('runs in the primary worktree, exactly as every command did before this field', async () => {
		const { primary } = await fleetLayout();
		for (const value of [undefined, null, '', '   ']) {
			expect(await resolveCommandRoot(value, primary, [])).toBe(primary);
		}
	});
});

describe('resolveCommandRoot — the name is looked up, never joined', () => {
	it('returns the mount worktree the provisioner recorded, which is NOT under the primary', async () => {
		const { primary, apiMount } = await fleetLayout();
		const resolved = await resolveCommandRoot('api', primary, [{ mountDir: 'api', path: apiMount }]);
		expect(resolved).toBe(await fs.realpath(apiMount));
		// The whole reason a join could not work: the mount is a COUSIN of
		// the primary, so `join(primary, ...)` can never name it.
		expect(resolved.startsWith(primary)).toBe(false);
	});

	it('matches case-insensitively, like every other mountDir comparison in the fleet', async () => {
		const { primary, apiMount } = await fleetLayout();
		expect(await resolveCommandRoot('API', primary, [{ mountDir: 'api', path: apiMount }])).toBe(
			await fs.realpath(apiMount)
		);
	});

	it('REFUSES a mount this run did not provision, and names what it did', async () => {
		const { primary, apiMount } = await fleetLayout();
		await expect(
			resolveCommandRoot('template', primary, [{ mountDir: 'api', path: apiMount }])
		).rejects.toBeInstanceOf(CommandRootError);
		await expect(
			resolveCommandRoot('template', primary, [{ mountDir: 'api', path: apiMount }])
		).rejects.toThrowError(/did not provision \(provisioned: api\)/);
	});

	it('REFUSES any mount at all on a run that provisioned none', async () => {
		const { primary } = await fleetLayout();
		await expect(resolveCommandRoot('api', primary, [])).rejects.toThrowError(/provisioned no mounts/);
		await expect(resolveCommandRoot('api', primary, undefined)).rejects.toThrowError(/provisioned no mounts/);
	});

	it('never falls back to the primary when the name does not resolve', async () => {
		// The silent-fallback failure this refusal exists to prevent: a check
		// that asked to verify repository B, ran in repository A, and came
		// back green.
		const { primary, apiMount } = await fleetLayout();
		await expect(resolveCommandRoot('web', primary, [{ mountDir: 'api', path: apiMount }])).rejects.toThrow();
	});
});

describe('resolveCommandRoot — path escape', () => {
	it.each([
		['..'],
		['../..'],
		['../outside'],
		['api/../../outside'],
		['.mounts'],
		['.git'],
		['node_modules'],
		['/etc'],
		['C:\\Windows'],
		['api\\..\\..'],
		['.hidden'],
		['con'],
		['nul']
	])('REFUSES %s before it is ever compared to a mount', async (name) => {
		const { primary, apiMount, outside } = await fleetLayout();
		// Deliberately hostile: a mount whose recorded dir is the traversal
		// string itself. The SHAPE gate runs first, so this can never match.
		const mounts = [
			{ mountDir: 'api', path: apiMount },
			{ mountDir: name, path: outside }
		];
		await expect(resolveCommandRoot(name, primary, mounts)).rejects.toBeInstanceOf(CommandRootError);
	});
});

describe('resolveCommandRoot — containment is proved, not assumed', () => {
	it('REFUSES a mount path that is a junction, which is what `linkPath` is', async () => {
		// `<primary>/.mounts/<dir>` is the junction the primary reaches a
		// mount through. Handing it to a shell as a cwd would defeat every
		// containment check downstream, so a descriptor that carried
		// `linkPath` where `path` belongs is refused rather than followed.
		const { primary, apiMount } = await fleetLayout();
		const linkPath = join(primary, '.mounts', 'api');
		await fs.symlink(apiMount, linkPath, linkKind);
		await expect(resolveCommandRoot('api', primary, [{ mountDir: 'api', path: linkPath }])).rejects.toThrowError(
			/missing, linked, or not a directory/
		);
	});

	it('REFUSES a mount path whose PARENT was swapped for a link after provisioning', async () => {
		// Final component is a real directory; the path still resolves
		// somewhere else. Only the realpath comparison catches this.
		const { root, primary } = await fleetLayout();
		const realParent = join(root, 'real-parent');
		const target = join(realParent, 'api');
		await fs.mkdir(target, { recursive: true });
		const aliasParent = join(root, 'alias-parent');
		await fs.symlink(realParent, aliasParent, linkKind);
		const throughAlias = join(aliasParent, 'api');
		await expect(
			resolveCommandRoot('api', primary, [{ mountDir: 'api', path: throughAlias }])
		).rejects.toThrowError(/resolves through a link/);
	});

	it('REFUSES a mount path that is a file, or that is gone', async () => {
		const { root, primary } = await fleetLayout();
		const file = join(root, 'not-a-dir');
		await fs.writeFile(file, 'x', 'utf8');
		await expect(resolveCommandRoot('api', primary, [{ mountDir: 'api', path: file }])).rejects.toThrowError(
			/missing, linked, or not a directory/
		);
		await expect(
			resolveCommandRoot('api', primary, [{ mountDir: 'api', path: join(root, 'gone') }])
		).rejects.toThrowError(/missing, linked, or not a directory/);
	});

	it('REFUSES a relative or empty mount path', async () => {
		const { primary } = await fleetLayout();
		await expect(
			resolveCommandRoot('api', primary, [{ mountDir: 'api', path: 'relative/api' }])
		).rejects.toThrowError(/no absolute path/);
		await expect(resolveCommandRoot('api', primary, [{ mountDir: 'api', path: '' }])).rejects.toThrowError(
			/no absolute path/
		);
	});
});
