import { describe, expect, it } from 'vitest';
import {
	describePlatform,
	describeSelf,
	detectCapabilities,
	detectDisplay,
	nodeMajor,
	normalizeCapabilities,
	readEnvironment,
	type CapabilityEnvironment,
	type CommandRunner
} from './capabilities';
import { MAX_CAPABILITY_TAG_LENGTH, MAX_CAPABILITY_TAGS } from './types';

/** Runner whose `--version` probes succeed only for the listed tools. */
function runnerWith(available: string[], failures: string[] = []): CommandRunner {
	return {
		run: async (command) => {
			if (failures.includes(command)) {
				throw new Error(`spawn ${command} ENOENT`);
			}
			return available.includes(command)
				? { code: 0, stdout: `${command} version 1.2.3`, stderr: '' }
				: { code: 127, stdout: '', stderr: 'not found' };
		}
	};
}

function environment(overrides: Partial<CapabilityEnvironment> = {}): CapabilityEnvironment {
	return { platform: 'linux', arch: 'x64', nodeVersion: 'v22.11.0', hasDisplay: false, ...overrides };
}

describe('nodeMajor / describePlatform', () => {
	it('parses the major from process.version shapes and rejects junk', () => {
		expect(nodeMajor('v22.11.0')).toBe(22);
		expect(nodeMajor('24.0.0')).toBe(24);
		expect(nodeMajor(' v20.1.0 ')).toBe(20);
		expect(nodeMajor('not-a-version')).toBeNull();
		expect(nodeMajor('')).toBeNull();
	});

	it('reports os/arch and stays inside the server platform cap', () => {
		expect(describePlatform(environment())).toBe('linux/x64');
		expect(describePlatform(environment({ platform: 'win32', arch: 'arm64' }))).toBe('win32/arm64');
		expect(describePlatform(environment({ platform: 'x'.repeat(200) })).length).toBeLessThanOrEqual(64);
	});
});

describe('detectDisplay', () => {
	it('assumes a display on Windows and macOS, and probes X11/Wayland elsewhere', () => {
		expect(detectDisplay('win32', {})).toBe(true);
		expect(detectDisplay('darwin', {})).toBe(true);
		expect(detectDisplay('linux', {})).toBe(false);
		expect(detectDisplay('linux', { DISPLAY: ':0' })).toBe(true);
		expect(detectDisplay('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
	});

	it('is wired through readEnvironment', () => {
		const env = readEnvironment({
			platform: 'linux',
			arch: 'arm64',
			version: 'v22.11.0',
			env: { DISPLAY: ':1' }
		});
		expect(env).toEqual({ platform: 'linux', arch: 'arm64', nodeVersion: 'v22.11.0', hasDisplay: true });
	});
});

describe('normalizeCapabilities (mirrors the server sanitizer)', () => {
	it('trims, drops empties, dedupes and preserves order', () => {
		expect(normalizeCapabilities([' docker ', 'git', 'docker', '', '   ', null, undefined, 'git'])).toEqual([
			'docker',
			'git'
		]);
	});

	it('truncates tags to 32 characters and caps the list at 16', () => {
		const long = 'x'.repeat(50);
		expect(normalizeCapabilities([long])[0]).toHaveLength(MAX_CAPABILITY_TAG_LENGTH);

		const many = Array.from({ length: 40 }, (_, index) => `tag-${index}`);
		expect(normalizeCapabilities(many)).toHaveLength(MAX_CAPABILITY_TAGS);
	});
});

describe('detectCapabilities matrix', () => {
	it('reports docker + git + display when everything is present', async () => {
		const tags = await detectCapabilities(
			runnerWith(['docker', 'git']),
			environment({ platform: 'darwin', arch: 'arm64', hasDisplay: true })
		);
		expect(tags).toEqual([
			'os:darwin',
			'arch:arm64',
			'node:22',
			'terminal',
			'workspace',
			'docker',
			'git',
			'display'
		]);
	});

	it('omits docker, git and display on a bare headless box', async () => {
		const tags = await detectCapabilities(runnerWith([]), environment());
		expect(tags).toEqual(['os:linux', 'arch:x64', 'node:22', 'terminal', 'workspace']);
		expect(tags).not.toContain('docker');
		expect(tags).not.toContain('git');
		expect(tags).not.toContain('display');
	});

	it('reports git without docker when only git is installed', async () => {
		const tags = await detectCapabilities(runnerWith(['git']), environment({ platform: 'win32' }));
		expect(tags).toContain('git');
		expect(tags).not.toContain('docker');
		expect(tags).toContain('os:win32');
	});

	it('treats a runner that throws (tool missing from PATH) as absent, not fatal', async () => {
		const tags = await detectCapabilities(runnerWith(['git'], ['docker']), environment());
		expect(tags).toContain('git');
		expect(tags).not.toContain('docker');
	});

	it('omits the node tag entirely when the version is unparseable', async () => {
		const tags = await detectCapabilities(runnerWith([]), environment({ nodeVersion: 'unknown' }));
		expect(tags.some((tag) => tag.startsWith('node:'))).toBe(false);
	});

	it('never exceeds the server capability caps', async () => {
		const tags = await detectCapabilities(
			runnerWith(['docker', 'git']),
			environment({ platform: 'darwin', hasDisplay: true })
		);
		expect(tags.length).toBeLessThanOrEqual(MAX_CAPABILITY_TAGS);
		for (const tag of tags) {
			expect(tag.length).toBeLessThanOrEqual(MAX_CAPABILITY_TAG_LENGTH);
		}
	});
});

describe('describeSelf', () => {
	it('bundles platform, version and capabilities, capping the version', async () => {
		const description = await describeSelf(runnerWith(['git']), environment(), '0.1.0');
		expect(description.platform).toBe('linux/x64');
		expect(description.version).toBe('0.1.0');
		expect(description.capabilities).toContain('git');

		const long = await describeSelf(runnerWith([]), environment(), 'v'.repeat(80));
		expect(long.version).toHaveLength(32);
	});
});
