import { describe, expect, it } from 'vitest';
import {
	FLEET_TASK_WORKSPACE_MAX_MOUNTS,
	FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN,
	FleetTaskWorkspaceMountError,
	isReservedMountDir,
	normalizeFleetTaskWorkspaceMounts
} from '../fleet-task-workspace.types.js';

/**
 * Multi-repo Task workspaces (self-build slice C). The normalizer is the
 * one gate between "what the planner assembled / what arrived on the
 * wire" and "what a node will clone next to the primary worktree", so
 * every refusal is pinned: a mount the node cannot honour exactly as
 * written must fail naming the field rather than be dropped or renamed.
 */

const PRIMARY = 'ever-works/ever-works';

const template = {
	repositoryId: 'ever-works/directory-web-template',
	repoUrl: 'https://github.com/ever-works/directory-web-template.git',
	baseRef: 'develop',
	branch: 'task/add-field-x-abc123',
	mountDir: 'directory-web-template'
};

const workspace = {
	repositoryId: 'ever-works/workspace',
	repoUrl: 'git@github.com:ever-works/workspace.git',
	baseRef: 'develop',
	branch: 'task/add-field-x-abc123',
	mountDir: 'workspace',
	writable: false,
	depth: 5
};

describe('normalizeFleetTaskWorkspaceMounts', () => {
	it('treats undefined, null and an empty array as "no mounts"', () => {
		expect(normalizeFleetTaskWorkspaceMounts(undefined, PRIMARY)).toEqual([]);
		expect(normalizeFleetTaskWorkspaceMounts(null, PRIMARY)).toEqual([]);
		expect(normalizeFleetTaskWorkspaceMounts([], PRIMARY)).toEqual([]);
	});

	it('returns trimmed copies with `writable` defaulting to true and `depth` passed through', () => {
		const [first, second] = normalizeFleetTaskWorkspaceMounts(
			[
				{ ...template, repositoryId: `  ${template.repositoryId}  `, mountDir: ' directory-web-template ' },
				workspace
			],
			PRIMARY
		);
		expect(first).toEqual({ ...template, writable: true });
		expect(second).toEqual(workspace);
		expect('depth' in first!).toBe(false);
	});

	it('refuses more than the mount limit', () => {
		const many = Array.from({ length: FLEET_TASK_WORKSPACE_MAX_MOUNTS + 1 }, (_, index) => ({
			...template,
			repositoryId: `ever-works/repo-${index}`,
			mountDir: `repo-${index}`
		}));
		expect(() => normalizeFleetTaskWorkspaceMounts(many, PRIMARY)).toThrow(FleetTaskWorkspaceMountError);
		expect(() => normalizeFleetTaskWorkspaceMounts(many, PRIMARY)).toThrow(/limit is 8/);
		expect(normalizeFleetTaskWorkspaceMounts(many.slice(0, FLEET_TASK_WORKSPACE_MAX_MOUNTS), PRIMARY)).toHaveLength(
			8
		);
	});

	it('refuses a non-array or a non-object entry', () => {
		expect(() => normalizeFleetTaskWorkspaceMounts('nope', PRIMARY)).toThrow(/must be an array/);
		expect(() => normalizeFleetTaskWorkspaceMounts(['nope'], PRIMARY)).toThrow(/mounts\[0\] must be an object/);
	});

	it.each([
		['a path', 'tools/template'],
		['a Windows path', 'tools\\template'],
		['a leading dot', '.hidden'],
		['.git', '.git'],
		['.mounts', '.mounts'],
		['node_modules', 'node_modules'],
		['a 65-character name', 'a'.repeat(65)],
		['a space', 'my template'],
		['an empty string', ''],
		// Windows strips trailing dots: `api.` and `api` would be ONE directory.
		['a trailing dot', 'api.'],
		// Windows device names cannot be created at all.
		['NUL', 'NUL'],
		['con', 'con'],
		['COM1', 'COM1'],
		['lpt9', 'lpt9'],
		['nul with an extension', 'nul.txt']
	])('refuses a mount directory that is %s', (_label, mountDir) => {
		expect(() => normalizeFleetTaskWorkspaceMounts([{ ...template, mountDir }], PRIMARY)).toThrow(
			FleetTaskWorkspaceMountError
		);
	});

	it('accepts the documented directory-name shape', () => {
		for (const mountDir of [
			'a',
			'directory-web-template',
			'v2.api',
			'my_repo',
			'A'.repeat(64),
			'console',
			'com10'
		]) {
			expect(FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN.test(mountDir)).toBe(true);
			expect(isReservedMountDir(mountDir)).toBe(false);
			expect(normalizeFleetTaskWorkspaceMounts([{ ...template, mountDir }], PRIMARY)[0]?.mountDir).toBe(mountDir);
		}
	});

	it('shares one reserved-name rule with the API and the Task validation', () => {
		for (const name of ['.git', '.MOUNTS', 'node_modules', 'CON', 'nul', 'Com1', 'LPT1.log', ' aux ', '']) {
			expect(isReservedMountDir(name)).toBe(true);
		}
		expect(isReservedMountDir('api')).toBe(false);
		expect(isReservedMountDir('lpt0')).toBe(false);
	});

	it('refuses two mounts on the same directory, case-insensitively (Windows and macOS collide)', () => {
		expect(() =>
			normalizeFleetTaskWorkspaceMounts([template, { ...workspace, mountDir: 'Directory-Web-Template' }], PRIMARY)
		).toThrow(/is used by another mount/);
	});

	it('refuses the primary repository as a mount and the same repository twice', () => {
		expect(() =>
			normalizeFleetTaskWorkspaceMounts([{ ...template, repositoryId: 'Ever-Works/Ever-Works' }], PRIMARY)
		).toThrow(/is the primary repository/);
		expect(() =>
			normalizeFleetTaskWorkspaceMounts([template, { ...template, mountDir: 'again' }], PRIMARY)
		).toThrow(/is mounted twice/);
	});

	it.each([
		['a missing repositoryId', { ...template, repositoryId: '' }, /repositoryId is required/],
		['a traversing repositoryId', { ...template, repositoryId: 'ever-works/../x' }, /repository identity/],
		['a missing repoUrl', { ...template, repoUrl: '  ' }, /repoUrl is required/],
		['a file: URL', { ...template, repoUrl: 'file:///tmp/repo' }, /remote, token-free/],
		['a Windows local path', { ...template, repoUrl: 'C:\\repos\\template' }, /remote, token-free/],
		['a POSIX local path', { ...template, repoUrl: '/srv/repos/template' }, /remote, token-free/],
		['a control character in the URL', { ...template, repoUrl: 'https://x/y\nz' }, /remote, token-free/],
		['a branch with a space', { ...template, branch: 'task/bad branch' }, /branch is not a valid/],
		['a baseRef starting with a dash', { ...template, baseRef: '-develop' }, /baseRef is not a valid/],
		['a non-boolean writable', { ...template, writable: 'yes' }, /writable must be a boolean/],
		['a zero depth', { ...template, depth: 0 }, /depth must be an integer/],
		['a fractional depth', { ...template, depth: 1.5 }, /depth must be an integer/]
	])('refuses %s', (_label, entry, message) => {
		expect(() => normalizeFleetTaskWorkspaceMounts([entry], PRIMARY)).toThrow(message);
	});

	it('names the offending entry by index', () => {
		expect(() => normalizeFleetTaskWorkspaceMounts([template, { ...workspace, branch: '' }], PRIMARY)).toThrow(
			/workspace\.mounts\[1\]\.branch is required/
		);
	});
});
