import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { posix, win32 } from 'node:path';
import {
	fleetHelperFileName,
	fleetHelperFingerprintPrefix,
	FLEET_HELPER_MAX_EVENTS,
	normalizeFleetHelperEvents,
	parseFleetHelperPolicyRecord,
	type FleetDesktopReason,
	type FleetHelperEvent,
	type FleetHelperPolicyRecord,
	type FleetHelperTrust
} from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07, FR-14, R-8, U2, U3) — the helper's admission
 * record, its verification, and the admission events the heartbeat reports.
 *
 * Three files in the node's config directory (beside `node-config.json`):
 *
 *   - `screen-helper/ever-works-screen[.exe]` — where `helper install` puts the
 *     helper (the owner may admit another path with `helper admit --path`);
 *   - `helper-policy.json` — the admission record (`0600`, owner-only ACL on
 *     Windows), written only by `helper admit` after the owner typed `admit`;
 *   - `helper-events.json` — the last {@link FLEET_HELPER_MAX_EVENTS} admission
 *     events (admit, revoke, verify-failed), re-sent on every heartbeat until
 *     the platform has written them (it de-duplicates by event id).
 *
 * The node verifies the file against the record IMMEDIATELY before every start
 * (FR-14): the SHA-256 of the bytes on disk must equal the admitted one, or the
 * start is refused `helper-untrusted` and a `verify-failed` event is recorded.
 * Same-user tampering between that check and the spawn is outside what a
 * hash-pinned helper can promise (the signed level, P3, closes it on Windows
 * with the existing deny-write broker).
 */

export const HELPER_POLICY_FILE_NAME = 'helper-policy.json';
export const HELPER_EVENTS_FILE_NAME = 'helper-events.json';
export const HELPER_INSTALL_DIR_NAME = 'screen-helper';
export const HELPER_POLICY_FILE_MODE = 0o600;

export interface HelperPaths {
	/** The config directory the three files live in. */
	dir: string;
	policyPath: string;
	eventsPath: string;
	/** Where `helper install` puts the helper. */
	installPath: string;
	/** P2: the owner's on-machine permission for control (`helper-control.json`); beside `policyPath` when absent. */
	controlPath?: string;
}

/** The helper's files beside a node config file. */
export function helperPathsFor(configPath: string, platform: string): HelperPaths {
	const paths = platform === 'win32' ? win32 : posix;
	const dir = paths.dirname(configPath);
	return {
		dir,
		policyPath: paths.join(dir, HELPER_POLICY_FILE_NAME),
		eventsPath: paths.join(dir, HELPER_EVENTS_FILE_NAME),
		installPath: paths.join(dir, HELPER_INSTALL_DIR_NAME, fleetHelperFileName(platform))
	};
}

/** The filesystem the helper's trust needs — injected so every branch is testable without a disk. */
export interface HelperFs {
	/** The file's contents, or null when it does not exist. */
	readText(path: string): Promise<string | null>;
	/** Write a file owner-only (0600 on POSIX, an owner-only ACL on Windows when the host supplies one). */
	writePrivate(path: string, content: string): Promise<void>;
	/** Write an executable the owner alone may change (0755 on POSIX, an owner-only ACL on Windows), atomically. */
	writeExecutable(path: string, bytes: Uint8Array): Promise<void>;
	/** Remove a file; missing is success. */
	remove(path: string): Promise<void>;
	/** True when a regular file exists at `path`. */
	isFile(path: string): Promise<boolean>;
	/** The SHA-256 (lowercase hex) of the file at `path`. */
	sha256(path: string): Promise<string>;
}

/** The real filesystem. `restrict` applies the owner-only ACL on Windows (`node-io`'s helper). */
export function createHelperFs(options: { platform: string; restrict?: (path: string) => Promise<void> | void }): HelperFs {
	const paths = options.platform === 'win32' ? win32 : posix;
	return {
		async readText(path) {
			try {
				return await fsp.readFile(path, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
				throw error;
			}
		},
		async writePrivate(path, content) {
			await fsp.mkdir(paths.dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			await fsp.writeFile(temporary, content, { mode: HELPER_POLICY_FILE_MODE, flag: 'wx' });
			try {
				if (options.platform !== 'win32') await fsp.chmod(temporary, HELPER_POLICY_FILE_MODE);
				else if (options.restrict) await options.restrict(temporary);
				await fsp.rename(temporary, path);
			} catch (error) {
				await fsp.rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
		},
		async writeExecutable(path, bytes) {
			await fsp.mkdir(paths.dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			await fsp.writeFile(temporary, bytes, { mode: 0o700, flag: 'wx' });
			try {
				if (options.platform !== 'win32') await fsp.chmod(temporary, 0o755);
				else if (options.restrict) await options.restrict(temporary);
				await fsp.rename(temporary, path);
			} catch (error) {
				await fsp.rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
		},
		async remove(path) {
			await fsp.rm(path, { force: true });
		},
		async isFile(path) {
			try {
				return (await fsp.stat(path)).isFile();
			} catch {
				return false;
			}
		},
		sha256(path) {
			return new Promise<string>((resolve, reject) => {
				const hash = createHash('sha256');
				const stream = createReadStream(path);
				stream.on('error', reject);
				stream.on('data', (chunk) => hash.update(chunk));
				stream.on('end', () => resolve(hash.digest('hex')));
			});
		}
	};
}

/** The admission record, or null when there is none (or it cannot be trusted — read as "unadmitted"). */
export async function readHelperPolicy(fs: HelperFs, policyPath: string): Promise<FleetHelperPolicyRecord | null> {
	let text: string | null;
	try {
		text = await fs.readText(policyPath);
	} catch {
		return null;
	}
	if (text === null) return null;
	try {
		return parseFleetHelperPolicyRecord(JSON.parse(text));
	} catch {
		return null;
	}
}

/** What a verification found. */
export type HelperVerification =
	| {
			ok: true;
			trust: Exclude<FleetHelperTrust, 'none'>;
			record: FleetHelperPolicyRecord;
			sha256: string;
			verifiedAt: string;
	  }
	| {
			ok: false;
			reason: Extract<FleetDesktopReason, 'helper-missing' | 'helper-unadmitted' | 'helper-untrusted'>;
			/** The record that failed (helper-untrusted / a missing admitted file), when there is one. */
			record: FleetHelperPolicyRecord | null;
			/** The helper file is on the machine (installed, or the admitted path). */
			present: boolean;
	  };

/**
 * Verify the helper against its admission record, NOW (call it immediately
 * before a start). Never throws.
 *
 *   - no record: `helper-unadmitted` when a helper is installed, else `helper-missing`;
 *   - a record whose file is gone: `helper-missing`;
 *   - a record whose file hashes differently: `helper-untrusted`;
 *   - a `signed` record: `helper-untrusted` until signed verification ships (P3) —
 *     never silently accepted as hash-pinned;
 *   - otherwise `hash-pinned`.
 */
export async function verifyHelper(
	fs: HelperFs,
	paths: Pick<HelperPaths, 'policyPath' | 'installPath'>,
	now: () => number = () => Date.now()
): Promise<HelperVerification> {
	const record = await readHelperPolicy(fs, paths.policyPath);
	if (!record) {
		const installed = await fs.isFile(paths.installPath);
		return { ok: false, reason: installed ? 'helper-unadmitted' : 'helper-missing', record: null, present: installed };
	}
	if (!(await fs.isFile(record.path))) {
		return { ok: false, reason: 'helper-missing', record, present: false };
	}
	let sha256: string;
	try {
		sha256 = await fs.sha256(record.path);
	} catch {
		return { ok: false, reason: 'helper-missing', record, present: false };
	}
	if (sha256 !== record.sha256 || record.level !== 'hash-pinned') {
		return { ok: false, reason: 'helper-untrusted', record, present: true };
	}
	return { ok: true, trust: 'hash-pinned', record, sha256, verifiedAt: new Date(now()).toISOString() };
}

/** Read the event log (newest last); unreadable reads as empty. */
export async function readHelperEvents(fs: HelperFs, eventsPath: string): Promise<FleetHelperEvent[]> {
	try {
		const text = await fs.readText(eventsPath);
		return text === null ? [] : normalizeFleetHelperEvents(JSON.parse(text));
	} catch {
		return [];
	}
}

/** Append one event, keeping the newest {@link FLEET_HELPER_MAX_EVENTS}. Never throws. */
export async function appendHelperEvent(
	fs: HelperFs,
	eventsPath: string,
	event: Omit<FleetHelperEvent, 'id' | 'at'> & { at?: string },
	now: () => number = () => Date.now()
): Promise<FleetHelperEvent | null> {
	const full: FleetHelperEvent = { ...event, id: randomUUID(), at: event.at ?? new Date(now()).toISOString() };
	try {
		const events = [...(await readHelperEvents(fs, eventsPath)), full].slice(-FLEET_HELPER_MAX_EVENTS);
		await fs.writePrivate(eventsPath, `${JSON.stringify(events, null, '\t')}\n`);
		return full;
	} catch {
		return null;
	}
}

/** The admit event for a record. */
export function admitEventFor(record: FleetHelperPolicyRecord): Omit<FleetHelperEvent, 'id' | 'at'> {
	return {
		kind: 'admit',
		level: record.level,
		version: record.version,
		fingerprintPrefix: fleetHelperFingerprintPrefix(record.sha256),
		published: record.published
	};
}
