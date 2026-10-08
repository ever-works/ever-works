import { normalizeFleetNodeVersionFloor } from '@ever-works/contracts';
import type { ConfigFileSystem } from './config-store';
import type { Logger } from './logger';
import { describeUpgradeRequired, type WorkerUpgradeHold } from './worker-loop';

/**
 * Node lifecycle (self-build slice AR) — what the PLATFORM last told this
 * machine about itself, and what the daemon does about it.
 *
 * Today that is the daemon version floor: every accepted heartbeat carries
 * the platform's minimum version and whether this daemon is below it, and
 * the lease refuses a below-floor daemon with `{ jobs: [], upgradeRequired:
 * true }`. This tracker is the one place both answers land. It holds (or
 * lifts) the worker lanes, logs the transition ONCE with the exact upgrade
 * command, and records the verdict beside the node config so `status` and
 * `doctor` — separate processes with no line to the running service — can
 * say "upgrade required" too.
 *
 * The record is a convenience copy, never a source of truth: the service
 * re-learns everything from its first beat, and a stale file can only make
 * `doctor` print an old verdict with its timestamp, never make the daemon
 * refuse or take work.
 */

/** Persisted beside the config; NOT a secret, and nothing reads it back into the runtime. */
export interface NodeLifecycleRecord {
	version: 1;
	/** When this verdict was last learned from the platform (ISO). */
	recordedAt: string;
	/** The daemon version that heard it. */
	daemonVersion: string;
	/** The platform's minimum daemon version, or null when it never named one. */
	minNodeVersion: string | null;
	/** True when the platform said this daemon is below the floor. */
	upgradeRequired: boolean;
}

/** Deliberately adjacent to the config, like the worker-session marker. */
export function nodeLifecycleRecordPath(configPath: string): string {
	return `${configPath}.lifecycle.json`;
}

/** The last recorded verdict, or null when there is none or it is unreadable. Never throws. */
export async function readNodeLifecycleRecord(
	fs: Pick<ConfigFileSystem, 'readFile'>,
	configPath: string
): Promise<NodeLifecycleRecord | null> {
	let raw: string | null;
	try {
		raw = await fs.readFile(nodeLifecycleRecordPath(configPath));
	} catch {
		return null;
	}
	return parseNodeLifecycleRecord(raw);
}

/** Defensive parse — a hand-edited or truncated file reads as "no record". */
export function parseNodeLifecycleRecord(raw: string | null): NodeLifecycleRecord | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const record = parsed as Partial<NodeLifecycleRecord>;
	if (
		record.version !== 1 ||
		typeof record.recordedAt !== 'string' ||
		!Number.isFinite(Date.parse(record.recordedAt))
	) {
		return null;
	}
	return {
		version: 1,
		recordedAt: record.recordedAt,
		daemonVersion: typeof record.daemonVersion === 'string' ? record.daemonVersion : '',
		minNodeVersion: normalizeFleetNodeVersionFloor(record.minNodeVersion),
		upgradeRequired: record.upgradeRequired === true
	};
}

/** Write the record. Best-effort by contract: the caller logs a failure and carries on. */
export async function writeNodeLifecycleRecord(
	fs: Pick<ConfigFileSystem, 'writeFile' | 'mkdir' | 'dirname'>,
	configPath: string,
	record: NodeLifecycleRecord
): Promise<void> {
	const path = nodeLifecycleRecordPath(configPath);
	await fs.mkdir(fs.dirname(path));
	await fs.writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** Anything that can be held: the work lane and the attended lane alike. */
export interface UpgradeHoldable {
	setUpgradeHold(hold: WorkerUpgradeHold | null): void;
}

export interface NodeLifecycleTrackerOptions {
	daemonVersion: string;
	logger: Logger;
	/** The lanes to hold — resolved per call, since they are built after the heartbeat. */
	lanes: () => readonly UpgradeHoldable[];
	persist?: (record: NodeLifecycleRecord) => Promise<void> | void;
	now?: () => number;
}

/** The heartbeat-answer fields this tracker reads. */
export interface HeartbeatLifecycleFields {
	minNodeVersion?: string;
	upgradeRequired?: boolean;
}

export class NodeLifecycleTracker {
	private minNodeVersion: string | null = null;
	private upgradeRequired = false;
	private lastPersisted: string | null = null;
	private readonly now: () => number;

	constructor(private readonly options: NodeLifecycleTrackerOptions) {
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Fold one accepted heartbeat answer in. A field the platform did not
	 * send (an API older than the floor) changes nothing — absence is not
	 * "you are fine now", it is "this platform does not say".
	 */
	applyHeartbeat(response: HeartbeatLifecycleFields): void {
		if (typeof response.minNodeVersion === 'string') this.minNodeVersion = response.minNodeVersion;
		if (typeof response.upgradeRequired === 'boolean') {
			this.transition(response.upgradeRequired);
		}
		this.persist();
	}

	/** The LEASE refused this daemon for the floor — the same fact, from the other channel. */
	applyLeaseRefusal(minNodeVersion: string | null): void {
		if (minNodeVersion) this.minNodeVersion = minNodeVersion;
		this.transition(true);
		this.persist();
	}

	snapshot(): NodeLifecycleRecord {
		return {
			version: 1,
			recordedAt: new Date(this.now()).toISOString(),
			daemonVersion: this.options.daemonVersion,
			minNodeVersion: this.minNodeVersion,
			upgradeRequired: this.upgradeRequired
		};
	}

	private transition(required: boolean): void {
		const was = this.upgradeRequired;
		this.upgradeRequired = required;
		const hold: WorkerUpgradeHold | null = required
			? {
					minNodeVersion: this.minNodeVersion,
					reason: describeUpgradeRequired(this.minNodeVersion, this.options.daemonVersion)
				}
			: null;
		// Re-applied on every verdict, not only on a transition: the lanes
		// are built after the first beat, and a lane that missed the first
		// one must still be held by the second.
		for (const lane of this.options.lanes()) {
			try {
				lane.setUpgradeHold(hold);
			} catch {
				// A lane that cannot be held is reported by its own state.
			}
		}
		if (required && !was) {
			this.options.logger.error(hold!.reason);
		} else if (!required && was) {
			this.options.logger.info(
				`Daemon ${this.options.daemonVersion} is at or above the platform's minimum version${
					this.minNodeVersion ? ` ${this.minNodeVersion}` : ''
				} again — leasing resumes`
			);
		}
	}

	private persist(): void {
		if (!this.options.persist) return;
		const record = this.snapshot();
		// Only on a CHANGE of verdict — not a disk write per beat.
		const fingerprint = JSON.stringify([record.daemonVersion, record.minNodeVersion, record.upgradeRequired]);
		if (fingerprint === this.lastPersisted) return;
		this.lastPersisted = fingerprint;
		void Promise.resolve()
			.then(() => this.options.persist?.(record))
			.catch((error: unknown) => {
				// Forget the fingerprint so the next beat retries the write.
				this.lastPersisted = null;
				this.options.logger.warn(
					`Could not record the platform's lifecycle verdict for \`status\` / \`doctor\`: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			});
	}
}
