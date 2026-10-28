import { randomUUID } from 'node:crypto';
import { publishFileExclusively } from './atomic-state-file';
import { CONFIG_FILE_MODE, supportsAtomicWrites, type ConfigFileSystem } from './config-store';

const MARKER_VERSION = 1;

interface WorkerSessionMarker {
	version: typeof MARKER_VERSION;
	sessionId: string;
	since: string;
}

export interface WorkerSafetyState {
	since: string;
	reason: string;
}

export type WorkerSafetyAcquisition =
	| { kind: 'acquired'; sessionId: string }
	| { kind: 'blocked'; state: WorkerSafetyState };

export interface WorkerSafetyGate {
	acquire(): Promise<WorkerSafetyAcquisition>;
	release(sessionId: string): Promise<void>;
	inspect(): Promise<WorkerSafetyState | null>;
	/** Operator-confirmed removal; callers must verify the process tree first. */
	clear(): Promise<void>;
}

export interface ConfigWorkerSafetyGateOptions {
	platform?: string;
	now?: () => number;
	createSessionId?: () => string;
}

export class WorkerSafetyPrerequisiteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkerSafetyPrerequisiteError';
	}
}

/** Deliberately adjacent to the config so a service restart finds the same guard. */
export function workerSafetyMarkerPath(configPath: string): string {
	return `${configPath}.worker-session`;
}

/**
 * Write-ahead crash guard for a worker process lifetime.
 *
 * Presence means a previous/current worker may own an unverified child tree.
 * The marker is created with exclusive-create before the first lease and is
 * removed only after a safe drain by the exact session that created it.
 */
export function createConfigWorkerSafetyGate(
	fs: ConfigFileSystem,
	configPath: string,
	options: ConfigWorkerSafetyGateOptions = {}
): WorkerSafetyGate {
	const markerPath = workerSafetyMarkerPath(configPath);
	const now = options.now ?? (() => Date.now());
	const createSessionId = options.createSessionId ?? randomUUID;

	const readRaw = async (): Promise<string | null> => {
		try {
			return await fs.readFile(markerPath);
		} catch (error) {
			throw prerequisite(`cannot read worker safety marker: ${detail(error)}`);
		}
	};

	const inspect = async (): Promise<WorkerSafetyState | null> => {
		const raw = await readRaw();
		return raw === null ? null : blockedState(raw, now());
	};

	return {
		async acquire(): Promise<WorkerSafetyAcquisition> {
			const existing = await readRaw();
			if (existing !== null) return { kind: 'blocked', state: blockedState(existing, now()) };
			if (!fs.createFileExclusive) {
				throw prerequisite('filesystem does not provide atomic exclusive marker creation');
			}

			await fs.mkdir(fs.dirname(markerPath));
			const marker: WorkerSessionMarker = {
				version: MARKER_VERSION,
				sessionId: createSessionId(),
				since: new Date(now()).toISOString()
			};
			try {
				await publishMarker(fs, markerPath, `${JSON.stringify(marker)}\n`, options.platform);
			} catch (error) {
				// Exclusive creation may have made the final directory entry and
				// then crashed mid-write. Any resulting bytes (including zero) are
				// a durable fail-closed marker, never permission to retry work.
				const afterFailure = await readRaw();
				if (afterFailure !== null) {
					return { kind: 'blocked', state: blockedState(afterFailure, now()) };
				}
				throw prerequisite(`could not durably arm worker safety marker: ${detail(error)}`);
			}

			try {
				if (options.platform === 'win32') {
					if (!fs.restrict) throw new Error('owner-only Windows ACL support is unavailable');
					await fs.restrict(markerPath);
				} else {
					await fs.chmod(markerPath, CONFIG_FILE_MODE);
				}
			} catch (error) {
				// Never remove it here. A retry must observe the already-created
				// marker and stay blocked until an operator verifies and clears it.
				//
				// Boot-probe retry: the real `restrict` already retried a TIMED-OUT `icacls`
				// (growing deadlines, bounded) before rejecting, so reaching this
				// line means either a genuine refusal or a timeout on every
				// attempt. Both still fail closed; the message says which (a
				// timeout's reads `probe timed out: …`).
				throw prerequisite(`worker safety marker is not proven owner-only: ${detail(error)}`);
			}

			return { kind: 'acquired', sessionId: marker.sessionId };
		},

		async release(sessionId: string): Promise<void> {
			const raw = await readRaw();
			const marker = raw === null ? null : parseMarker(raw);
			if (!marker || marker.sessionId !== sessionId) {
				throw prerequisite('worker session does not own the durable safety marker');
			}
			if (!fs.remove) throw prerequisite('filesystem cannot remove the durable safety marker');
			await fs.remove(markerPath);
			if ((await readRaw()) !== null) {
				throw prerequisite('worker safety marker still exists after safe-session release');
			}
		},

		inspect,

		async clear(): Promise<void> {
			if ((await readRaw()) === null) return;
			if (!fs.remove) throw prerequisite('filesystem cannot clear the durable safety marker');
			await fs.remove(markerPath);
			if ((await readRaw()) !== null) {
				throw prerequisite('worker safety marker still exists after explicit clearance');
			}
		}
	};
}

/**
 * Arm the marker COMPLETE or not at all (2026-10-28).
 *
 * It is armed before the first lease, so a kill while it is being written
 * means no work ran. Created in place, such a kill left an empty or torn
 * marker, which reads (correctly, since nothing can tell it apart from a
 * damaged one) as a quarantine an operator has to clear. So the marker is
 * staged in a flushed temp file and hard-linked into place: a link, unlike
 * a rename, refuses an existing target, so two workers racing still agree
 * on one owner (the loser sees `EEXIST` and reads the winner's marker).
 *
 * A filesystem that refuses the hard link (FAT, some network shares) falls
 * back to the exclusive in-place create, which keeps the fail-closed
 * behaviour above for its rare torn write.
 */
async function publishMarker(
	fs: ConfigFileSystem,
	markerPath: string,
	content: string,
	platform: string | undefined
): Promise<void> {
	const link = fs.link;
	if (supportsAtomicWrites(fs) && typeof link === 'function') {
		// Only a refusal of the LINK itself falls back. A failure while staging
		// the temp file (disk full, I/O error) is reported as it is: retrying it
		// as an in-place create is exactly the torn write this avoids.
		let linkError: unknown = null;
		const ops = {
			...fs,
			link: async (existing: string, newPath: string): Promise<void> => {
				try {
					await link(existing, newPath);
				} catch (error) {
					linkError = error;
					throw error;
				}
			}
		};
		try {
			await publishFileExclusively(ops, markerPath, content, { platform });
			return;
		} catch (error) {
			if (error !== linkError || errorCode(error) === 'EEXIST') throw error;
		}
	}
	// Still exclusive: a marker that appeared meanwhile makes this reject with EEXIST.
	await fs.createFileExclusive!(markerPath, content);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
}

function parseMarker(raw: string): WorkerSessionMarker | null {
	try {
		const candidate = JSON.parse(raw) as Partial<WorkerSessionMarker>;
		if (
			candidate.version !== MARKER_VERSION ||
			typeof candidate.sessionId !== 'string' ||
			!candidate.sessionId ||
			typeof candidate.since !== 'string' ||
			!Number.isFinite(Date.parse(candidate.since))
		) {
			return null;
		}
		return {
			version: MARKER_VERSION,
			sessionId: candidate.sessionId,
			since: new Date(candidate.since).toISOString()
		};
	} catch {
		return null;
	}
}

function blockedState(raw: string, now: number): WorkerSafetyState {
	const marker = parseMarker(raw);
	if (!marker) {
		return {
			since: new Date(now).toISOString(),
			reason: 'Worker safety marker is unreadable, corrupt, or incomplete; verify every prior process tree and explicitly clear quarantine'
		};
	}
	return {
		since: marker.since,
		reason: 'Previous worker session did not release its safety marker; verify every prior process tree and explicitly clear quarantine'
	};
}

function prerequisite(message: string): WorkerSafetyPrerequisiteError {
	return new WorkerSafetyPrerequisiteError(`Worker safety prerequisite failed: ${message}`);
}

function detail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
