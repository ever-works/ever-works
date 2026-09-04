import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_APP_VERSION } from './version';

/**
 * `NODE_APP_VERSION` is what the node reports to the platform and what the
 * published package is versioned as. The two are maintained by hand (the
 * manifest lives outside `rootDir`), so pin them together here — and the
 * publish workflow refuses a tag that disagrees with either.
 */
describe('NODE_APP_VERSION', () => {
	it('matches package.json', () => {
		const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
		expect(NODE_APP_VERSION).toBe(manifest.version);
	});

	it('is a plain semver', () => {
		expect(NODE_APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
