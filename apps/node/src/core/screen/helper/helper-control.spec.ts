import { describe, expect, it } from 'vitest';
import type { FleetHelperManifest } from '@ever-works/contracts';
import { HelperAdmissionError, helperAdmit, type HelperAdmissionDeps } from './helper-admission';
import {
	helperControlAllow,
	helperControlDeny,
	helperControlPath,
	helperControlStatus,
	isHelperControlAllowed,
	readHelperControl
} from './helper-control';
import { helperPathsFor, readHelperEvents, readHelperPolicy } from './helper-trust';
import { memoryHelperFs, sha256Of } from './helper-test-kit';

/**
 * Desktop view & control (FL-07 P2) — `ever-works-node helper control allow |
 * deny | status`: the owner's permission ON the machine, typed, bound to one
 * admission of the helper, every change an audited event.
 */

const paths = helperPathsFor('/home/me/.config/ever-works-node/node-config.json', 'linux');
const BINARY = 'the published helper';
const PUBLISHED: FleetHelperManifest = {
	schemaVersion: 1,
	version: '0.1.0',
	targets: { 'linux-x64': { sha256: sha256Of(BINARY), url: 'https://downloads.example/ever-works-screen' } }
};

function deps(fs = memoryHelperFs({ [paths.installPath]: BINARY }), typed: string | null = 'control', at = '2026-10-27T03:00:00Z') {
	const out: string[] = [];
	const value: HelperAdmissionDeps = {
		fs,
		paths,
		platform: 'linux',
		arch: 'x64',
		manifest: PUBLISHED,
		hostName: 'build-01',
		out: (line) => out.push(line),
		now: () => Date.parse(at),
		readLine: async () => typed
	};
	return { deps: value, out, fs };
}

async function admitted(at = '2026-10-27T02:00:00Z') {
	const fs = memoryHelperFs({ [paths.installPath]: BINARY });
	await helperAdmit(deps(fs, 'admit', at).deps);
	return fs;
}

describe('helper control allow', () => {
	it('needs an approved helper first', async () => {
		const { deps: d, fs } = deps();
		await expect(helperControlAllow(d)).rejects.toBeInstanceOf(HelperAdmissionError);
		expect(await readHelperControl(fs, helperControlPath(paths))).toBeNull();
	});

	it('records the permission only after the typed word, for this admission, as an event', async () => {
		const fs = await admitted();
		const { deps: d, out } = deps(fs);
		const record = await helperControlAllow(d);
		const admission = await readHelperPolicy(fs, paths.policyPath);
		expect(record).toMatchObject({ allowed: true, admissionAt: admission?.acknowledgedAt });
		expect(await isHelperControlAllowed(fs, paths, admission)).toBe(true);
		expect(out.some((line) => line.includes('never forwarded'))).toBe(true);
		const events = await readHelperEvents(fs, paths.eventsPath);
		expect(events.map((event) => event.kind)).toEqual(['admit', 'control-allow']);
		expect(events[1]).toMatchObject({ fingerprintPrefix: sha256Of(BINARY).slice(0, 8) });
	});

	it('changes nothing when the word is not typed, or nobody is at the keyboard', async () => {
		const fs = await admitted();
		await expect(helperControlAllow(deps(fs, 'yes').deps)).rejects.toBeInstanceOf(HelperAdmissionError);
		const { deps: noTty } = deps(fs);
		delete (noTty as { readLine?: unknown }).readLine;
		await expect(helperControlAllow(noTty)).rejects.toBeInstanceOf(HelperAdmissionError);
		expect(await readHelperControl(fs, helperControlPath(paths))).toBeNull();
	});

	it('is void once the helper is approved again', async () => {
		const fs = await admitted('2026-10-27T02:00:00Z');
		await helperControlAllow(deps(fs).deps);
		await helperAdmit(deps(fs, 'admit', '2026-10-28T02:00:00Z').deps);
		expect(await isHelperControlAllowed(fs, paths, await readHelperPolicy(fs, paths.policyPath))).toBe(false);
		const report = await helperControlStatus(deps(fs).deps);
		expect(report).toMatchObject({ allowed: false, stale: true });
	});
});

describe('helper control deny', () => {
	it('withdraws the permission and records it once', async () => {
		const fs = await admitted();
		await helperControlAllow(deps(fs).deps);
		expect(await helperControlDeny(deps(fs).deps)).toBe(true);
		expect(await helperControlDeny(deps(fs).deps)).toBe(false);
		expect(await isHelperControlAllowed(fs, paths, await readHelperPolicy(fs, paths.policyPath))).toBe(false);
		const kinds = (await readHelperEvents(fs, paths.eventsPath)).map((event) => event.kind);
		expect(kinds).toEqual(['admit', 'control-allow', 'control-deny']);
	});

	it('reports status as JSON', async () => {
		const fs = await admitted();
		const { deps: d, out } = deps(fs);
		await helperControlStatus(d, { json: true });
		expect(JSON.parse(out[out.length - 1])).toEqual({ allowed: false, changedAt: null, stale: false });
	});
});
