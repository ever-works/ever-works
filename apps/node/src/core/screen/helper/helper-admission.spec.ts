import { describe, expect, it } from 'vitest';
import type { FleetHelperManifest } from '@ever-works/contracts';
import {
	HelperAdmissionError,
	helperAdmit,
	helperInstall,
	helperRevoke,
	helperStatus,
	type HelperAdmissionDeps
} from './helper-admission';
import { helperPathsFor, readHelperEvents, readHelperPolicy } from './helper-trust';
import { memoryHelperFs, sha256Of } from './helper-test-kit';

/** Desktop view & control (FL-07, T-13, FR-15 … FR-19) — admission on the machine, by its owner. */

const paths = helperPathsFor('/home/me/.config/ever-works-node/node-config.json', 'linux');
const BINARY = 'the published helper';
const EMPTY: FleetHelperManifest = { schemaVersion: 1, version: '0.1.0', targets: {} };
const PUBLISHED: FleetHelperManifest = {
	schemaVersion: 1,
	version: '0.1.0',
	targets: { 'linux-x64': { sha256: sha256Of(BINARY), url: 'https://downloads.example/ever-works-screen' } }
};

function deps(overrides: Partial<HelperAdmissionDeps> & { typed?: string | null } = {}) {
	const out: string[] = [];
	const fs = overrides.fs ?? memoryHelperFs();
	const typed = overrides.typed;
	const base: HelperAdmissionDeps = {
		fs,
		paths,
		platform: 'linux',
		arch: 'x64',
		manifest: PUBLISHED,
		hostName: 'build-01',
		out: (line) => out.push(line),
		now: () => Date.parse('2026-10-26T03:00:00Z'),
		...(typed !== undefined ? { readLine: async () => typed } : {}),
		...overrides
	};
	return { deps: base, out, fs };
}

describe('helper admit', () => {
	it('shows both fingerprints, and approves only after the typed word', async () => {
		const { deps: d, out, fs } = deps({ fs: memoryHelperFs({ [paths.installPath]: BINARY }), typed: 'admit' });
		const record = await helperAdmit(d);
		expect(record).toMatchObject({
			level: 'hash-pinned',
			published: true,
			version: '0.1.0',
			sha256: sha256Of(BINARY)
		});
		expect(out.some((line) => line.startsWith('Its SHA-256'))).toBe(true);
		expect(out.some((line) => line.startsWith('Published'))).toBe(true);
		expect(await readHelperPolicy(fs, paths.policyPath)).toEqual(record);
		const events = await readHelperEvents(fs, paths.eventsPath);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: 'admit',
			level: 'hash-pinned',
			fingerprintPrefix: sha256Of(BINARY).slice(0, 8)
		});
	});

	it('refuses when the word is not typed, and writes nothing', async () => {
		const { deps: d, fs } = deps({ fs: memoryHelperFs({ [paths.installPath]: BINARY }), typed: 'yes' });
		await expect(helperAdmit(d)).rejects.toBeInstanceOf(HelperAdmissionError);
		expect(await readHelperPolicy(fs, paths.policyPath)).toBeNull();
		expect(await readHelperEvents(fs, paths.eventsPath)).toEqual([]);
	});

	it('refuses with no person at the keyboard', async () => {
		const { deps: d } = deps({ fs: memoryHelperFs({ [paths.installPath]: BINARY }) });
		await expect(helperAdmit(d)).rejects.toThrow(/keyboard/);
	});

	it('refuses a file whose fingerprint differs from the published one, even with the word', async () => {
		const { deps: d, fs } = deps({ fs: memoryHelperFs({ [paths.installPath]: 'tampered' }), typed: 'admit' });
		await expect(helperAdmit(d)).rejects.toThrow(/fingerprints differ/);
		expect(await readHelperPolicy(fs, paths.policyPath)).toBeNull();
	});

	it('admits a build of one’s own only with --allow-unpublished, recorded as unpublished', async () => {
		const own = memoryHelperFs({ '/tmp/my-helper': 'my build' });
		const refused = deps({ fs: own, manifest: EMPTY, typed: 'admit' });
		await expect(helperAdmit(refused.deps, { path: '/tmp/my-helper' })).rejects.toThrow(/--allow-unpublished/);
		const allowed = deps({ fs: own, manifest: EMPTY, typed: 'admit' });
		const record = await helperAdmit(allowed.deps, { path: '/tmp/my-helper', allowUnpublished: true });
		expect(record).toMatchObject({ published: false, version: null, path: '/tmp/my-helper' });
	});

	it('names the install command when there is no helper', async () => {
		const { deps: d } = deps({ typed: 'admit' });
		await expect(helperAdmit(d)).rejects.toThrow(/helper install/);
	});
});

describe('helper revoke', () => {
	it('removes the record and records the revoke', async () => {
		const { deps: d, fs } = deps({ fs: memoryHelperFs({ [paths.installPath]: BINARY }), typed: 'admit' });
		await helperAdmit(d);
		expect(await helperRevoke(d)).toBe(true);
		expect(await readHelperPolicy(fs, paths.policyPath)).toBeNull();
		expect((await readHelperEvents(fs, paths.eventsPath)).map((event) => event.kind)).toEqual(['admit', 'revoke']);
		expect(await helperRevoke(d)).toBe(false);
	});
});

describe('helper install', () => {
	it('refuses when this node version publishes no helper for the platform', async () => {
		const { deps: d } = deps({ manifest: EMPTY });
		await expect(helperInstall(d)).rejects.toThrow(/publishes no screen helper/);
	});

	it('keeps a download only when it matches the published fingerprint', async () => {
		const good = deps({
			fetchFn: (async () => new Response(BINARY, { status: 200 })) as unknown as typeof fetch
		});
		await helperInstall(good.deps);
		expect(await good.fs.isFile(paths.installPath)).toBe(true);
		const bad = deps({
			fetchFn: (async () => new Response('something else', { status: 200 })) as unknown as typeof fetch
		});
		await expect(helperInstall(bad.deps)).rejects.toThrow(/does not match/);
		expect(await bad.fs.isFile(paths.installPath)).toBe(false);
	});
});

describe('helper status', () => {
	it('reports a changed helper as untrusted', async () => {
		const { deps: d, fs } = deps({ fs: memoryHelperFs({ [paths.installPath]: BINARY }), typed: 'admit' });
		await helperAdmit(d);
		await fs.writeExecutable(paths.installPath, new TextEncoder().encode('changed'));
		const report = await helperStatus({ ...d, out: () => undefined }, { json: true });
		expect(report).toMatchObject({ admitted: true, trust: 'none', reason: 'helper-untrusted' });
	});
});
