import { describe, expect, it } from 'vitest';
import { FLEET_HELPER_MAX_EVENTS } from '@ever-works/contracts';
import { appendHelperEvent, helperPathsFor, readHelperEvents, verifyHelper } from './helper-trust';
import { memoryHelperFs, sha256Of } from './helper-test-kit';

/** Desktop view & control (FL-07, T-12, FR-14, U2, U3) — verification immediately before a start. */

const paths = helperPathsFor('/home/me/.config/ever-works-node/node-config.json', 'linux');
const BINARY = 'helper bytes v1';

function record(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: 1,
		path: paths.installPath,
		sha256: sha256Of(BINARY),
		level: 'hash-pinned',
		version: '0.1.0',
		published: true,
		acknowledgedAt: '2026-10-26T01:00:00.000Z',
		...overrides
	});
}

describe('helperPathsFor', () => {
	it('keeps every helper file beside the config', () => {
		expect(paths).toEqual({
			dir: '/home/me/.config/ever-works-node',
			policyPath: '/home/me/.config/ever-works-node/helper-policy.json',
			eventsPath: '/home/me/.config/ever-works-node/helper-events.json',
			installPath: '/home/me/.config/ever-works-node/screen-helper/ever-works-screen'
		});
		expect(helperPathsFor('C:\\Users\\me\\AppData\\Roaming\\ever-works-node\\node-config.json', 'win32').installPath).toBe(
			'C:\\Users\\me\\AppData\\Roaming\\ever-works-node\\screen-helper\\ever-works-screen.exe'
		);
	});
});

describe('verifyHelper', () => {
	it('reads no helper as helper-missing', async () => {
		expect(await verifyHelper(memoryHelperFs(), paths)).toMatchObject({ ok: false, reason: 'helper-missing', present: false });
	});

	it('reads an installed helper without a record as helper-unadmitted (never started)', async () => {
		const fs = memoryHelperFs({ [paths.installPath]: BINARY });
		expect(await verifyHelper(fs, paths)).toMatchObject({ ok: false, reason: 'helper-unadmitted', present: true });
	});

	it('accepts the admitted file as hash-pinned', async () => {
		const fs = memoryHelperFs({ [paths.installPath]: BINARY, [paths.policyPath]: record() });
		const verification = await verifyHelper(fs, paths, () => Date.parse('2026-10-26T02:00:00Z'));
		expect(verification).toMatchObject({ ok: true, trust: 'hash-pinned', verifiedAt: '2026-10-26T02:00:00.000Z' });
	});

	it('refuses a file with one altered byte as helper-untrusted', async () => {
		const fs = memoryHelperFs({ [paths.installPath]: 'helper bytes v2', [paths.policyPath]: record() });
		expect(await verifyHelper(fs, paths)).toMatchObject({ ok: false, reason: 'helper-untrusted', present: true });
	});

	it('reads an admitted file that is gone as helper-missing', async () => {
		const fs = memoryHelperFs({ [paths.policyPath]: record() });
		expect(await verifyHelper(fs, paths)).toMatchObject({ ok: false, reason: 'helper-missing' });
	});

	it('never accepts a signed record before signed verification exists', async () => {
		const fs = memoryHelperFs({ [paths.installPath]: BINARY, [paths.policyPath]: record({ level: 'signed' }) });
		expect(await verifyHelper(fs, paths)).toMatchObject({ ok: false, reason: 'helper-untrusted' });
	});

	it('reads a corrupt record as no record', async () => {
		const fs = memoryHelperFs({ [paths.installPath]: BINARY, [paths.policyPath]: '{not json' });
		expect(await verifyHelper(fs, paths)).toMatchObject({ ok: false, reason: 'helper-unadmitted' });
	});
});

describe('helper events', () => {
	it('appends events with ids and keeps the newest twenty', async () => {
		const fs = memoryHelperFs();
		for (let index = 0; index < FLEET_HELPER_MAX_EVENTS + 5; index += 1) {
			await appendHelperEvent(fs, paths.eventsPath, { kind: 'revoke' });
		}
		const events = await readHelperEvents(fs, paths.eventsPath);
		expect(events).toHaveLength(FLEET_HELPER_MAX_EVENTS);
		expect(new Set(events.map((event) => event.id)).size).toBe(FLEET_HELPER_MAX_EVENTS);
	});
});
