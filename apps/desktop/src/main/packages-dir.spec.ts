import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { withDefaultPackagesDir } from './packages-dir';

/**
 * The two things worth testing here are the precedence rule and the failure
 * tolerance. Neither needs Electron or a real filesystem, which is why the
 * helper takes an injected `mkdir`.
 */

describe('withDefaultPackagesDir', () => {
	it('defaults to <userData>/agent-plugins when nothing is configured', () => {
		const mkdir = vi.fn();

		const result = withDefaultPackagesDir({}, '/home/u/.config/ever', mkdir);

		expect(result.AGENT_PLUGINS_DIR).toBe(path.join('/home/u/.config/ever', 'agent-plugins'));
		expect(mkdir).toHaveBeenCalledWith(result.AGENT_PLUGINS_DIR);
	});

	it('does NOT override an explicit setting', () => {
		const mkdir = vi.fn();

		const result = withDefaultPackagesDir({ AGENT_PLUGINS_DIR: '/srv/packages' }, '/home/u', mkdir);

		// An operator who has chosen a directory keeps it, and we do not
		// create a second one they never asked for.
		expect(result.AGENT_PLUGINS_DIR).toBe('/srv/packages');
		expect(mkdir).not.toHaveBeenCalled();
	});

	it('still sets the value when the directory cannot be created', () => {
		const mkdir = vi.fn(() => {
			throw new Error('EACCES');
		});

		const result = withDefaultPackagesDir({}, '/home/u', mkdir);

		// The scanner treats a missing directory as an empty registry, so a
		// read-only profile must degrade to "no packages" rather than to a
		// launch that fails.
		expect(result.AGENT_PLUGINS_DIR).toBe(path.join('/home/u', 'agent-plugins'));
	});

	it('leaves every other entry untouched', () => {
		const result = withDefaultPackagesDir(
			{ DATABASE_URL: 'postgres://x', FEATURE_AGENT_PLUGINS: 'true' },
			'/home/u',
			vi.fn()
		);

		expect(result.DATABASE_URL).toBe('postgres://x');
		expect(result.FEATURE_AGENT_PLUGINS).toBe('true');
	});

	it('does not mutate the map it was given', () => {
		const entries = { A: '1' };

		withDefaultPackagesDir(entries, '/home/u', vi.fn());

		// The caller re-reads this map per launch; mutating it would make the
		// default sticky across a config change.
		expect(entries).toEqual({ A: '1' });
	});
});
