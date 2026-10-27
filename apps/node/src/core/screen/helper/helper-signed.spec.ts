import { describe, expect, it } from 'vitest';
import type { FleetHelperManifest } from '@ever-works/contracts';
import { DesktopHelperHost } from '../desktop-helper-backend';
import { HelperAdmissionError, helperAdmitSigned, type HelperAdmissionDeps } from './helper-admission';
import {
	helperPathsFor,
	readHelperEvents,
	readHelperPolicy,
	verifyHelper,
	type HelperSignatureChecker
} from './helper-trust';
import { fakeHelperSpawner, memoryHelperFs, sha256Of } from './helper-test-kit';

/**
 * Desktop view & control (FL-07 P3, T-43, T-44, FR-57, FR-58) — the signed
 * admission: approved by the OS-verified signature of the publisher the node
 * package names, kept across an update by the same publisher, refused for
 * anyone else, and never accepted without a signature check.
 */

const paths = helperPathsFor('/Users/me/Library/ever-works-node/node-config.json', 'darwin');
const TEAM = 'ABCDE12345';
const MANIFEST: FleetHelperManifest = {
	schemaVersion: 1,
	version: '0.2.0',
	targets: {
		'darwin-arm64': { sha256: sha256Of('unsigned'), url: 'https://downloads.example/h', signer: TEAM }
	}
};
const NO_SIGNER: FleetHelperManifest = { schemaVersion: 1, version: '0.2.0', targets: {} };

const signedBy =
	(team: string): HelperSignatureChecker =>
	async (_path, expected) =>
		team === expected ? { ok: true, signer: team } : { ok: false, reason: 'wrong-signer' };

function deps(overrides: Partial<HelperAdmissionDeps> = {}) {
	const out: string[] = [];
	const fs = memoryHelperFs({ [paths.installPath]: 'signed v1' });
	const value: HelperAdmissionDeps = {
		fs,
		paths,
		platform: 'darwin',
		arch: 'arm64',
		manifest: MANIFEST,
		hostName: 'design-mac',
		out: (line) => out.push(line),
		readLine: async () => 'admit',
		now: () => Date.parse('2026-10-27T10:00:00Z'),
		checkSignature: signedBy(TEAM),
		...overrides
	};
	return { deps: value, out, fs };
}

describe('helper admit --signed', () => {
	it('records a signed admission after the OS signature names the published team and the word is typed', async () => {
		const { deps: d, out, fs } = deps();
		const record = await helperAdmitSigned(d);
		expect(record).toMatchObject({ level: 'signed', signer: TEAM, published: true });
		expect(out.some((line) => line.startsWith('Signed by') && line.includes(TEAM))).toBe(true);
		expect(await readHelperPolicy(fs, paths.policyPath)).toEqual(record);
		expect((await readHelperEvents(fs, paths.eventsPath))[0]).toMatchObject({ kind: 'admit', level: 'signed' });
	});

	it('refuses another publisher, an unpublished signer, no checker, and no typed word', async () => {
		await expect(helperAdmitSigned(deps({ checkSignature: signedBy('ZZZZZ99999') }).deps)).rejects.toThrow(
			/not by ABCDE12345/
		);
		await expect(helperAdmitSigned(deps({ manifest: NO_SIGNER }).deps)).rejects.toBeInstanceOf(
			HelperAdmissionError
		);
		const noChecker = deps().deps;
		delete (noChecker as { checkSignature?: unknown }).checkSignature;
		await expect(helperAdmitSigned(noChecker)).rejects.toBeInstanceOf(HelperAdmissionError);
		const { deps: wrongWord, fs } = deps({ readLine: async () => 'yes' });
		await expect(helperAdmitSigned(wrongWord)).rejects.toBeInstanceOf(HelperAdmissionError);
		expect(await readHelperPolicy(fs, paths.policyPath)).toBeNull();
	});
});

describe('verifying a signed admission (before every start)', () => {
	async function admitted() {
		const { deps: d, fs } = deps();
		await helperAdmitSigned(d);
		return fs;
	}

	it('keeps the approval across an update by the same publisher (FR-58)', async () => {
		const fs = await admitted();
		await fs.writeExecutable(paths.installPath, new TextEncoder().encode('signed v2'));
		const verification = await verifyHelper(fs, paths, () => 0, signedBy(TEAM));
		expect(verification).toMatchObject({ ok: true, trust: 'signed' });
	});

	it('refuses a file now signed by someone else, and is never trusted without a signature check', async () => {
		const fs = await admitted();
		expect(await verifyHelper(fs, paths, () => 0, signedBy('ZZZZZ99999'))).toMatchObject({
			ok: false,
			reason: 'helper-untrusted'
		});
		expect(await verifyHelper(fs, paths)).toMatchObject({ ok: false, reason: 'helper-untrusted' });
	});

	it('streams under a signed admission, and stops offering the signed build once it is the one here (T-44)', async () => {
		const fs = await admitted();
		const fake = fakeHelperSpawner();
		const host = new DesktopHelperHost({
			paths,
			fs,
			platform: 'darwin',
			env: {},
			spawner: fake.spawner,
			checkSignature: signedBy(TEAM),
			signedAvailable: true
		});
		await host.refresh();
		expect(host.tags()).toEqual(['helper:screen', 'screen:desktop']);
		const report = await host.report();
		expect(report.helperTrust).toBe('signed');
		expect(report.helper).not.toHaveProperty('signedAvailable');
	});

	it('offers the signed build beside a hash-pinned helper', async () => {
		const fs = memoryHelperFs({
			[paths.installPath]: 'unsigned',
			[paths.policyPath]: JSON.stringify({
				schemaVersion: 1,
				path: paths.installPath,
				sha256: sha256Of('unsigned'),
				level: 'hash-pinned',
				version: '0.2.0',
				published: true,
				acknowledgedAt: '2026-10-27T09:00:00.000Z'
			})
		});
		const host = new DesktopHelperHost({
			paths,
			fs,
			platform: 'darwin',
			env: {},
			spawner: fakeHelperSpawner().spawner,
			signedAvailable: true
		});
		await host.refresh();
		expect((await host.report()).helper).toMatchObject({ trust: 'hash-pinned', signedAvailable: true });
	});

	it('asks the OS once per bytes for heartbeats, and again when the file changes', async () => {
		const fs = await admitted();
		let calls = 0;
		const counting: HelperSignatureChecker = async (path, expected, sha256) => {
			calls += 1;
			return signedBy(TEAM)(path, expected, sha256);
		};
		const host = new DesktopHelperHost({
			paths,
			fs,
			platform: 'darwin',
			env: {},
			spawner: fakeHelperSpawner().spawner,
			checkSignature: counting
		});
		await host.refresh();
		await host.refresh();
		expect(calls).toBe(1);
		await fs.writeExecutable(paths.installPath, new TextEncoder().encode('signed v3'));
		await host.refresh();
		expect(calls).toBe(2);
	});
});
