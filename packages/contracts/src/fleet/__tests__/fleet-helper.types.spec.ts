import { describe, expect, it } from 'vitest';

import {
	FLEET_HELPER_ADMIT_WORD,
	FLEET_HELPER_MAX_EVENTS,
	fleetHelperEventAuditAction,
	fleetHelperFileName,
	fleetHelperFingerprintPrefix,
	fleetHelperManifestPublishes,
	fleetHelperTarget,
	formatFleetHelperFingerprint,
	isFleetSha256Hex,
	normalizeFleetHelperEvents,
	parseFleetHelperManifest,
	parseFleetHelperPolicyRecord
} from '../fleet-helper.types';

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('helper targets', () => {
	it('maps the platforms a helper is built for', () => {
		expect(fleetHelperTarget('darwin', 'arm64')).toBe('darwin-arm64');
		expect(fleetHelperTarget('win32', 'x64')).toBe('win32-x64');
		expect(fleetHelperTarget('linux', 'x64')).toBe('linux-x64');
		expect(fleetHelperTarget('linux', 'arm64')).toBeNull();
		expect(fleetHelperFileName('win32')).toBe('ever-works-screen.exe');
		expect(fleetHelperFileName('darwin')).toBe('ever-works-screen');
	});
});

describe('fingerprints', () => {
	it('accepts lowercase sha256 only and shows an 8-digit prefix', () => {
		expect(isFleetSha256Hex(SHA)).toBe(true);
		expect(isFleetSha256Hex(SHA.toUpperCase())).toBe(false);
		expect(isFleetSha256Hex(SHA.slice(1))).toBe(false);
		expect(fleetHelperFingerprintPrefix('ABCDEF1234' + SHA.slice(10))).toBe('abcdef12');
		expect(formatFleetHelperFingerprint('abcd1234ef')).toBe('abcd 1234 ef');
		expect(FLEET_HELPER_ADMIT_WORD).toBe('admit');
	});
});

describe('manifest', () => {
	it('keeps valid https targets and drops the rest', () => {
		const manifest = parseFleetHelperManifest({
			schemaVersion: 1,
			version: '0.1.0',
			targets: {
				'linux-x64': { sha256: SHA, url: 'https://downloads.example/ever-works-screen' },
				'win32-x64': { sha256: SHA, url: 'http://insecure.example/x.exe' },
				'darwin-arm64': { sha256: 'nope', url: 'https://x.example/y' },
				'solaris-sparc': { sha256: SHA, url: 'https://x.example/z' }
			}
		});
		expect(manifest).not.toBeNull();
		expect(Object.keys(manifest!.targets)).toEqual(['linux-x64']);
		expect(fleetHelperManifestPublishes(manifest, 'linux-x64', SHA)).toBe(true);
		expect(fleetHelperManifestPublishes(manifest, 'linux-x64', OTHER)).toBe(false);
		expect(fleetHelperManifestPublishes(manifest, 'win32-x64', SHA)).toBe(false);
		expect(fleetHelperManifestPublishes(null, 'linux-x64', SHA)).toBe(false);
	});

	it('refuses something that is not a manifest', () => {
		expect(parseFleetHelperManifest({ schemaVersion: 2, version: '1', targets: {} })).toBeNull();
		expect(parseFleetHelperManifest({ schemaVersion: 1, version: 'a b', targets: {} })).toBeNull();
		expect(parseFleetHelperManifest(null)).toBeNull();
	});
});

describe('admission record', () => {
	const record = {
		schemaVersion: 1,
		path: '/home/me/.ever-works/helper/ever-works-screen',
		sha256: SHA,
		level: 'hash-pinned',
		version: '0.1.0',
		published: true,
		acknowledgedAt: '2026-10-26T01:00:00.000Z'
	};

	it('reads a record', () => {
		expect(parseFleetHelperPolicyRecord(record)).toEqual(record);
	});

	it('refuses a record that cannot be trusted (the node then reads "unadmitted")', () => {
		expect(parseFleetHelperPolicyRecord({ ...record, sha256: 'x' })).toBeNull();
		expect(parseFleetHelperPolicyRecord({ ...record, level: 'none' })).toBeNull();
		expect(parseFleetHelperPolicyRecord({ ...record, acknowledgedAt: 'yesterday' })).toBeNull();
		expect(parseFleetHelperPolicyRecord({ ...record, path: '' })).toBeNull();
		expect(parseFleetHelperPolicyRecord('{}')).toBeNull();
	});

	it('reads a missing published flag as unpublished', () => {
		const { published: _published, ...rest } = record;
		expect(parseFleetHelperPolicyRecord(rest)?.published).toBe(false);
	});
});

describe('admission events', () => {
	const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

	it('keeps usable events once each, newest last, capped', () => {
		const events = normalizeFleetHelperEvents([
			{ id: id(1), kind: 'admit', at: '2026-10-26T01:00:00Z', level: 'hash-pinned', fingerprintPrefix: 'abcdef12' },
			{ id: id(1), kind: 'admit', at: '2026-10-26T01:00:00Z' },
			{ id: 'nope', kind: 'admit', at: '2026-10-26T01:00:00Z' },
			{ id: id(2), kind: 'explode', at: '2026-10-26T01:00:00Z' },
			{ id: id(3), kind: 'verify-failed', at: '2026-10-26T02:00:00Z', reason: 'helper-untrusted', sha256: SHA }
		]);
		expect(events.map((event) => event.id)).toEqual([id(1), id(3)]);
		expect(events[1]).toEqual({
			id: id(3),
			kind: 'verify-failed',
			at: '2026-10-26T02:00:00Z',
			reason: 'helper-untrusted'
		});
		const many = Array.from({ length: 50 }, (_, n) => ({ id: id(n + 10), kind: 'revoke', at: '2026-10-26T01:00:00Z' }));
		const capped = normalizeFleetHelperEvents(many);
		expect(capped).toHaveLength(FLEET_HELPER_MAX_EVENTS);
		expect(capped[capped.length - 1].id).toBe(id(59));
	});

	it('maps each kind to its audit name', () => {
		expect(fleetHelperEventAuditAction('admit')).toBe('node.helper.admit');
		expect(fleetHelperEventAuditAction('revoke')).toBe('node.helper.revoke');
		expect(fleetHelperEventAuditAction('verify-failed')).toBe('node.helper.verify-failed');
	});
});
