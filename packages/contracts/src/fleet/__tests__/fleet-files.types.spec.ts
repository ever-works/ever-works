import { describe, expect, it } from 'vitest';

import {
	FLEET_CREDENTIAL_FILE_PATTERNS,
	FLEET_FILES_LIMITS,
	FLEET_FILES_MAX_BYTES_RECORD,
	FLEET_FILES_RECORD_TAGS,
	FleetFilesStreamTracker,
	decodeFleetFilesRecords,
	encodeFleetFilesBytesRecord,
	encodeFleetFilesHeaderRecord,
	fleetFilesPolicyFor,
	isCredentialShapedName,
	isFleetFileName,
	normalizeFleetFileRelativePath,
	parseFleetFilesOpenParams,
	sanitizeFleetFileEntry,
	sanitizeFleetFileRootsResult,
	sanitizeFleetFilesStreamHeader,
	sanitizeFleetFilesWritePolicy
} from '../fleet-files.types.js';
import { FLEET_LINK_CREDIT_WINDOW_BYTES, fleetLinkMachineVerbActionFamily } from '../fleet-link.types.js';

describe('FL-11 files — limits (CONTRACTS §10)', () => {
	it('match the contract: 64 KiB chunks, 8 MiB window, 2 GiB, 5 000 entries, 2 per node, 4 per user', () => {
		expect(FLEET_FILES_LIMITS).toEqual({
			chunkBytes: 65536,
			windowBytes: 8 * 1024 * 1024,
			maxOpBytes: 2 * 1024 * 1024 * 1024,
			maxEntries: 5000,
			maxConcurrentPerNode: 2,
			maxConcurrentPerUser: 4
		});
		expect(FLEET_FILES_LIMITS.windowBytes).toBe(FLEET_LINK_CREDIT_WINDOW_BYTES);
	});

	it('routes the files.roots verb to the files family', () => {
		expect(fleetLinkMachineVerbActionFamily('files.roots')).toBe('files');
	});
});

describe('FL-11 files — paths', () => {
	it('normalises folders and refuses escapes (U4)', () => {
		expect(normalizeFleetFileRelativePath('')).toBe('');
		expect(normalizeFleetFileRelativePath('/')).toBe('');
		expect(normalizeFleetFileRelativePath('src//server/./')).toBe('src/server');
		expect(normalizeFleetFileRelativePath('../etc')).toBeNull();
		expect(normalizeFleetFileRelativePath('src/../../etc')).toBeNull();
		expect(normalizeFleetFileRelativePath('/etc/passwd')).toBeNull();
		expect(normalizeFleetFileRelativePath('C:/Windows')).toBeNull();
		expect(normalizeFleetFileRelativePath('src\\server')).toBeNull();
		expect(normalizeFleetFileRelativePath('a\0b')).toBeNull();
	});

	it('names have no separator, dots or control characters', () => {
		expect(isFleetFileName('app.ts')).toBe(true);
		expect(isFleetFileName('.env')).toBe(true);
		for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\nb', 'x'.repeat(256)])
			expect(isFleetFileName(bad)).toBe(false);
	});

	it('parses channel params', () => {
		expect(parseFleetFilesOpenParams({ root: 'abc123', path: 'src' })).toEqual({ root: 'abc123', path: 'src' });
		expect(parseFleetFilesOpenParams({ root: 'abc123' })).toEqual({ root: 'abc123', path: '' });
		expect(parseFleetFilesOpenParams({ root: '../x', path: '' })).toBeNull();
		expect(parseFleetFilesOpenParams({ root: 'abc', path: '../..' })).toBeNull();
	});
});

describe('FL-11 files — credential-shaped names (FR-8)', () => {
	it.each([
		'.env',
		'.env.local',
		'.ENV.production',
		'server.pem',
		'tls.key',
		'cert.p12',
		'store.pfx',
		'app.jks',
		'release.keystore',
		'vault.kdbx',
		'id_rsa',
		'id_rsa.pub',
		'id_ed25519',
		'putty.ppk',
		'.netrc',
		'.npmrc',
		'.pypirc',
		'credentials',
		'credentials.json',
		'service-account-prod.json',
		'secret.gpg',
		'key.asc',
		'kubeconfig'
	])('flags %s', (name) => {
		expect(isCredentialShapedName(name)).toBe(true);
	});

	it.each(['env.ts', 'keyboard.ts', 'README.md', 'environment.yml', '.envrc', 'config.json', 'app.ts'])(
		'does not flag %s',
		(name) => {
			expect(isCredentialShapedName(name)).toBe(false);
		}
	);

	it('matches the folder patterns on the path tail only', () => {
		expect(isCredentialShapedName('credentials', '.aws/credentials')).toBe(true);
		expect(isCredentialShapedName('config.json', '.docker/config.json')).toBe(true);
		expect(isCredentialShapedName('config', 'home/.kube/config')).toBe(true);
		expect(isCredentialShapedName('config', 'src/config')).toBe(false);
		expect(isCredentialShapedName('config.json', 'src/config.json')).toBe(false);
	});

	it('is one fixed list', () => {
		expect(FLEET_CREDENTIAL_FILE_PATTERNS.length).toBeGreaterThan(20);
		expect(new Set(FLEET_CREDENTIAL_FILE_PATTERNS).size).toBe(FLEET_CREDENTIAL_FILE_PATTERNS.length);
	});
});

describe('FL-11 files — conflict policy (FR-13)', () => {
	it('skips by default', () => {
		expect(fleetFilesPolicyFor(undefined, 'app.ts')).toBe('skip');
		expect(fleetFilesPolicyFor({}, 'app.ts')).toBe('skip');
		expect(fleetFilesPolicyFor({ replace: ['README.md'] }, 'app.ts')).toBe('skip');
	});

	it('replaces what was named, or everything', () => {
		expect(fleetFilesPolicyFor({ replace: ['app.ts'] }, 'app.ts')).toBe('replace');
		expect(fleetFilesPolicyFor({ replaceAll: true }, 'anything')).toBe('replace');
	});

	it('sanitises a policy off the wire', () => {
		expect(sanitizeFleetFilesWritePolicy({ replaceAll: 'yes', replace: ['ok', '../x', 3] })).toEqual({
			replace: ['ok']
		});
		expect(sanitizeFleetFilesWritePolicy(null)).toEqual({});
	});
});

describe('FL-11 files — the files stream', () => {
	it('round-trips header and byte records', () => {
		const header = encodeFleetFilesHeaderRecord({
			path: 'a/b.txt',
			kind: 'file',
			size: 3,
			mode: 0o644,
			mtimeMs: 1
		})!;
		const bytes = encodeFleetFilesBytesRecord(new Uint8Array([1, 2, 3]))!;
		const payload = new Uint8Array(header.byteLength + bytes.byteLength);
		payload.set(header, 0);
		payload.set(bytes, header.byteLength);
		const records = decodeFleetFilesRecords(payload)!;
		expect(records).toHaveLength(2);
		expect(records[0]).toEqual({
			tag: FLEET_FILES_RECORD_TAGS.header,
			header: { path: 'a/b.txt', kind: 'file', size: 3, mode: 0o644, mtimeMs: 1 }
		});
		expect(records[1].tag).toBe(FLEET_FILES_RECORD_TAGS.bytes);
	});

	it('refuses a truncated record, an unknown tag and an escaping header', () => {
		const bytes = encodeFleetFilesBytesRecord(new Uint8Array([1, 2, 3]))!;
		expect(decodeFleetFilesRecords(bytes.subarray(0, bytes.byteLength - 1))).toBeNull();
		const unknown = new Uint8Array(bytes);
		unknown[0] = 0x01;
		expect(decodeFleetFilesRecords(unknown)).toBeNull();
		const escaping = encodeFleetFilesHeaderRecord({ path: '../x', kind: 'file', size: 0, mode: 0, mtimeMs: 0 })!;
		expect(decodeFleetFilesRecords(escaping)).toBeNull();
	});

	it('caps a byte record at a frame', () => {
		expect(encodeFleetFilesBytesRecord(new Uint8Array(FLEET_FILES_MAX_BYTES_RECORD))).not.toBeNull();
		expect(encodeFleetFilesBytesRecord(new Uint8Array(FLEET_FILES_MAX_BYTES_RECORD + 1))).toBeNull();
		expect(FLEET_FILES_MAX_BYTES_RECORD + 5).toBe(FLEET_FILES_LIMITS.chunkBytes);
	});

	it('refuses links that leave the stream', () => {
		expect(sanitizeFleetFilesStreamHeader({ path: 'l', kind: 'link', size: 0, target: '/etc' })).toBeNull();
		expect(sanitizeFleetFilesStreamHeader({ path: 'l', kind: 'link', size: 0, target: 'C:/x' })).toBeNull();
		expect(sanitizeFleetFilesStreamHeader({ path: 'l', kind: 'link', size: 0, target: '../releases/42' })).toEqual({
			path: 'l',
			kind: 'link',
			size: 0,
			mode: 0o644,
			mtimeMs: 0,
			target: '../releases/42'
		});
	});

	it('tracks sizes and limits', () => {
		const tracker = new FleetFilesStreamTracker();
		expect(
			tracker.push({ tag: 0x48, header: { path: 'a', kind: 'file', size: 2, mode: 0, mtimeMs: 0 } })
		).toBeNull();
		expect(tracker.complete).toBe(false);
		expect(tracker.push({ tag: 0x42, bytes: new Uint8Array(3) })).toMatch(/longer/);
		const ok = new FleetFilesStreamTracker();
		ok.push({ tag: 0x48, header: { path: 'a', kind: 'file', size: 2, mode: 0, mtimeMs: 0 } });
		expect(ok.push({ tag: 0x42, bytes: new Uint8Array(2) })).toBeNull();
		expect(ok.complete).toBe(true);
		expect(ok.push({ tag: 0x42, bytes: new Uint8Array(1) })).toMatch(/longer/);
	});
});

describe('FL-11 files — sanitisers', () => {
	it('keeps link flags for links only', () => {
		expect(
			sanitizeFleetFileEntry({ name: 'current', kind: 'link', linkInsideRoot: true, linkKind: 'folder' })
		).toMatchObject({ kind: 'link', linkInsideRoot: true, linkKind: 'folder' });
		expect(sanitizeFleetFileEntry({ name: 'a.ts', kind: 'file', linkInsideRoot: true })).toMatchObject({
			linkInsideRoot: null
		});
		expect(sanitizeFleetFileEntry({ name: '', kind: 'file' })).toBeNull();
	});

	it('drops malformed roots', () => {
		const result = sanitizeFleetFileRootsResult({
			platform: 'linux',
			separator: '/',
			roots: [
				{ id: 'abc', kind: 'checkout', label: 'api', path: '/srv/api' },
				{ id: 'bad id', kind: 'checkout', path: '/x' },
				{ id: 'def', kind: 'home', path: '/home/me' }
			],
			refused: 1
		});
		expect(result.roots).toEqual([{ id: 'abc', kind: 'checkout', label: 'api', path: '/srv/api' }]);
		expect(result.refused).toBe(1);
	});
});
