import {
	FLEET_SELF_UPDATE_MAX_ERROR_LENGTH,
	compareFleetNodeVersions,
	isFleetNodeVersionBelowFloor,
	normalizeFleetNodeVersionFloor,
	type FleetNodeSelfUpdateReport
} from '@ever-works/contracts';
import type { CommandRunner } from '../capabilities';
import type { ConfigFileSystem } from '../config-store';
import type { Logger } from '../logger';

/**
 * Fleet node link (FL-02, T-25, spec S12, FR-37, FR-38, U16) — the node's
 * OPT-IN self-update (`ever-works-node start --auto-update`).
 *
 * When the platform raises its version floor above this daemon, or names a
 * recommended version above it (`recommendedNodeVersion` on the beat), a node
 * started with the flag upgrades itself: it waits until no job is running (it
 * never kills work), installs the new version through the SAME installer it
 * came from — only an `npm install -g` install is upgraded; a monorepo
 * checkout or an install it cannot identify is refused, never guessed — and
 * then exits with {@link SELF_UPDATE_EXIT_CODE} so its service manager starts
 * the new binary. The before/after versions are logged, and recorded beside
 * the config so the NEW process can report the update and log it once.
 *
 * A failed install leaves the old version running, is logged once, is
 * reported on the heartbeat (`selfUpdate`, so the hub can say "Self-update
 * failed on build-02 at 09:12 — run the command yourself"), and is retried
 * on a ladder ({@link SELF_UPDATE_RETRY_LADDER_MS}) — sooner when the target
 * changes. Without the flag the node only reports (`enabled: false`).
 *
 * It never downloads an arbitrary URL: the package name is fixed and the
 * registry is whatever the machine's npm already uses.
 */

/** The exit code that asks the service manager for a restart into the new binary. */
export const SELF_UPDATE_EXIT_CODE = 75;

/** The one package a self-update installs. */
export const SELF_UPDATE_PACKAGE = 'ever-works-node';

/** Waits after the 1st, 2nd, 3rd and later failures for the same target. */
export const SELF_UPDATE_RETRY_LADDER_MS: readonly number[] = [
	15 * 60_000,
	60 * 60_000,
	6 * 60 * 60_000,
	24 * 60 * 60_000
];

/** The longest an install may run before it is called failed. */
export const SELF_UPDATE_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** How long `npm root -g` may take. */
export const SELF_UPDATE_DETECT_TIMEOUT_MS = 20_000;

/** How this daemon was installed, as far as it can tell. */
export type NodeInstall =
	| { kind: 'npm-global'; root: string }
	| { kind: 'checkout' }
	| { kind: 'unknown'; detail: string };

function normalizePath(path: string, platform: string): string {
	const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
	return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Classify the running binary's path. `npm-global` only when it lives inside
 * `<npm root -g>/ever-works-node/`; a path through `apps/node/` of a checkout
 * is `checkout`; anything else is `unknown` — and refused.
 */
export function classifyNodeInstall(
	entryPath: string | null | undefined,
	npmGlobalRoot: string | null | undefined,
	platform: string
): NodeInstall {
	if (!entryPath) return { kind: 'unknown', detail: 'the running binary’s path is unknown' };
	const entry = normalizePath(entryPath, platform);
	if (/\/apps\/node\/(dist|src)\//.test(entry)) return { kind: 'checkout' };
	if (npmGlobalRoot) {
		const root = normalizePath(npmGlobalRoot, platform);
		if (root.length > 0 && entry.startsWith(`${root}/${SELF_UPDATE_PACKAGE}/`)) {
			return { kind: 'npm-global', root: npmGlobalRoot };
		}
	}
	return { kind: 'unknown', detail: 'not an `npm install -g` install' };
}

/** Ask npm where its global packages live and classify the running binary against it. */
export async function detectNodeInstall(input: {
	entryPath: string | null | undefined;
	runner: CommandRunner;
	platform: string;
}): Promise<NodeInstall> {
	const early = classifyNodeInstall(input.entryPath, null, input.platform);
	if (early.kind === 'checkout' || !input.entryPath) return early;
	let root: string | null = null;
	try {
		const result = await input.runner.run('npm', ['root', '-g'], { timeoutMs: SELF_UPDATE_DETECT_TIMEOUT_MS });
		if (result.code === 0) {
			const line = result.stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0);
			root = line ? line.trim() : null;
		}
	} catch {
		root = null;
	}
	if (!root) return { kind: 'unknown', detail: 'npm is not available to this service' };
	return classifyNodeInstall(input.entryPath, root, input.platform);
}

/** What one accepted heartbeat said about versions. */
export interface SelfUpdateHeartbeat {
	minNodeVersion?: string | null;
	upgradeRequired?: boolean;
	recommendedNodeVersion?: string | null;
}

/**
 * The version a self-update should install, or null when none is due:
 *
 *  - the recommended version, when the platform names one above this daemon
 *    (and not below the floor);
 *  - `latest`, when this daemon is below the floor and no usable recommended
 *    version is named;
 *  - null for a daemon whose version cannot be compared (a dev build) — like
 *    the floor itself, the self-update fails open, never bricking a machine.
 */
export function selfUpdateTarget(current: string, heartbeat: SelfUpdateHeartbeat): string | null {
	if (compareFleetNodeVersions(current, current) === null) return null;
	const floor = normalizeFleetNodeVersionFloor(heartbeat.minNodeVersion ?? null);
	const recommended = normalizeFleetNodeVersionFloor(heartbeat.recommendedNodeVersion ?? null);
	const usableRecommended =
		recommended !== null && (floor === null || !isFleetNodeVersionBelowFloor(recommended, floor))
			? recommended
			: null;
	if (usableRecommended !== null && compareFleetNodeVersions(current, usableRecommended) === -1) {
		return usableRecommended;
	}
	const below =
		heartbeat.upgradeRequired === true || (floor !== null && isFleetNodeVersionBelowFloor(current, floor));
	if (below) return 'latest';
	return null;
}

// ─── The record beside the config ──────────────────────────────────────────

/** Written just before the restart (or after a failure); read by the next process. NOT a secret. */
export interface SelfUpdateRecord {
	version: 1;
	outcome: 'updated' | 'failed';
	/** ISO instant of the attempt's end. */
	at: string;
	fromVersion: string;
	targetVersion: string;
	error?: string | null;
}

export function selfUpdateRecordPath(configPath: string): string {
	return `${configPath}.self-update.json`;
}

/** The last record, or null when there is none or it is unreadable. Never throws. */
export async function readSelfUpdateRecord(
	fs: Pick<ConfigFileSystem, 'readFile'>,
	configPath: string
): Promise<SelfUpdateRecord | null> {
	try {
		const raw = await fs.readFile(selfUpdateRecordPath(configPath));
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<SelfUpdateRecord>;
		if (
			value?.version !== 1 ||
			(value.outcome !== 'updated' && value.outcome !== 'failed') ||
			typeof value.at !== 'string' ||
			typeof value.fromVersion !== 'string' ||
			typeof value.targetVersion !== 'string'
		) {
			return null;
		}
		return {
			version: 1,
			outcome: value.outcome,
			at: value.at,
			fromVersion: value.fromVersion,
			targetVersion: value.targetVersion,
			error: typeof value.error === 'string' ? value.error : null
		};
	} catch {
		return null;
	}
}

export async function writeSelfUpdateRecord(
	fs: Pick<ConfigFileSystem, 'writeFile'>,
	configPath: string,
	record: SelfUpdateRecord
): Promise<void> {
	await fs.writeFile(selfUpdateRecordPath(configPath), `${JSON.stringify(record, null, 2)}\n`);
}

// ─── The controller ────────────────────────────────────────────────────────

export interface SelfUpdateControllerOptions {
	/** `--auto-update` was given. Off → report only. */
	enabled: boolean;
	/** This daemon's version. */
	currentVersion: string;
	runner: CommandRunner;
	logger: Logger;
	platform: string;
	/** The running binary's real path (`process.argv[1]`, resolved). */
	entryPath: string | null | undefined;
	/** True when no job (work, live view, management) is running on any lane. */
	isIdle: () => boolean;
	/** Stop the node and exit {@link SELF_UPDATE_EXIT_CODE}; `to` is the installed version. */
	requestRestart: (to: string) => void;
	/** Record the outcome beside the config. Best-effort. */
	persist?: (record: SelfUpdateRecord) => Promise<void> | void;
	/** What the previous process recorded, read at startup. */
	previous?: SelfUpdateRecord | null;
	now?: () => number;
	/** Test seam for the installer detection. */
	detectInstall?: () => Promise<NodeInstall>;
}

/** One short sentence, never an installer's own output (it can carry local paths). */
function boundedError(message: string): string {
	return message.length > FLEET_SELF_UPDATE_MAX_ERROR_LENGTH
		? message.slice(0, FLEET_SELF_UPDATE_MAX_ERROR_LENGTH)
		: message;
}

export class SelfUpdateController {
	private readonly now: () => number;
	private attempting = false;
	private restarting = false;
	private lastFailure: { at: number; target: string; error: string; count: number } | null = null;
	private lastSuccess: { at: string; fromVersion: string } | null = null;
	private waitingLoggedFor: string | null = null;
	private disabledLoggedFor: string | null = null;

	constructor(private readonly options: SelfUpdateControllerOptions) {
		this.now = options.now ?? (() => Date.now());
		const previous = options.previous ?? null;
		if (previous?.outcome === 'updated') {
			if (previous.fromVersion !== options.currentVersion) {
				this.lastSuccess = { at: previous.at, fromVersion: previous.fromVersion };
				options.logger.info(
					`Self-update complete: ${SELF_UPDATE_PACKAGE} ${previous.fromVersion} → ${options.currentVersion}`
				);
			} else {
				// The install said it worked, but this process is still the old
				// version: the service manager resolves another binary first.
				this.recordFailure(
					previous.targetVersion,
					`installed ${previous.targetVersion}, but the service still runs ${options.currentVersion}`,
					Date.parse(previous.at)
				);
			}
		} else if (previous?.outcome === 'failed' && previous.fromVersion === options.currentVersion) {
			this.recordFailure(
				previous.targetVersion,
				previous.error ?? 'the last attempt failed',
				Date.parse(previous.at)
			);
		}
	}

	/** What the heartbeat reports (`selfUpdate`). */
	report(): FleetNodeSelfUpdateReport {
		return {
			enabled: this.options.enabled,
			failedAt: this.lastFailure ? new Date(this.lastFailure.at).toISOString() : null,
			error: this.lastFailure?.error ?? null,
			targetVersion: this.lastFailure?.target ?? null,
			updatedAt: this.lastSuccess?.at ?? null,
			fromVersion: this.lastSuccess?.fromVersion ?? null
		};
	}

	/** True while an install runs or a restart was requested. */
	get busy(): boolean {
		return this.attempting || this.restarting;
	}

	/** Called on every accepted heartbeat; starts an attempt in the background when one is due. */
	onHeartbeat(heartbeat: SelfUpdateHeartbeat): void {
		const target = selfUpdateTarget(this.options.currentVersion, heartbeat);
		if (target === null || this.busy) return;
		if (!this.options.enabled) {
			if (this.disabledLoggedFor !== target) {
				this.disabledLoggedFor = target;
				this.options.logger.info(
					`A newer ${SELF_UPDATE_PACKAGE} is wanted (${target}); self-update is off on this computer — start it with --auto-update to let it upgrade itself.`
				);
			}
			return;
		}
		if (!this.retryDue(target)) return;
		if (!this.options.isIdle()) {
			if (this.waitingLoggedFor !== target) {
				this.waitingLoggedFor = target;
				this.options.logger.info(`Self-update to ${target} is waiting for the running jobs to finish.`);
			}
			return;
		}
		void this.attempt(target);
	}

	/** Run one attempt now (tests await it; `onHeartbeat` starts it in the background). */
	async attempt(target: string): Promise<'updated' | 'failed' | 'skipped'> {
		if (this.busy) return 'skipped';
		this.attempting = true;
		const from = this.options.currentVersion;
		try {
			let install: NodeInstall;
			try {
				install = this.options.detectInstall
					? await this.options.detectInstall()
					: await detectNodeInstall({
							entryPath: this.options.entryPath,
							runner: this.options.runner,
							platform: this.options.platform
						});
			} catch {
				install = { kind: 'unknown', detail: 'the install could not be identified' };
			}
			if (install.kind !== 'npm-global') {
				const error =
					install.kind === 'checkout'
						? 'built from a monorepo checkout — pull and run `pnpm build:node` yourself'
						: `installer unknown: ${install.detail}`;
				await this.fail(target, error, from);
				return 'failed';
			}
			this.options.logger.info(
				`Self-update: installing ${SELF_UPDATE_PACKAGE}@${target} (this node runs ${from})`
			);
			let result: Awaited<ReturnType<CommandRunner['run']>>;
			try {
				result = await this.options.runner.run('npm', ['install', '-g', `${SELF_UPDATE_PACKAGE}@${target}`], {
					timeoutMs: SELF_UPDATE_INSTALL_TIMEOUT_MS
				});
			} catch {
				await this.fail(target, 'npm could not be started', from);
				return 'failed';
			}
			if (result.code !== 0) {
				const error = result.timedOut
					? `npm install timed out after ${SELF_UPDATE_INSTALL_TIMEOUT_MS / 60_000} min`
					: `npm install exited ${result.code ?? 'abnormally'}`;
				await this.fail(target, error, from);
				return 'failed';
			}
			const at = new Date(this.now()).toISOString();
			await this.persist({ version: 1, outcome: 'updated', at, fromVersion: from, targetVersion: target });
			this.options.logger.info(
				`Self-update installed ${SELF_UPDATE_PACKAGE}@${target} (was ${from}); restarting under the service manager (exit ${SELF_UPDATE_EXIT_CODE}).`
			);
			this.restarting = true;
			this.options.requestRestart(target);
			return 'updated';
		} finally {
			this.attempting = false;
		}
	}

	private retryDue(target: string): boolean {
		const failure = this.lastFailure;
		if (!failure || failure.target !== target) return true;
		const ladder = SELF_UPDATE_RETRY_LADDER_MS;
		const wait = ladder[Math.min(failure.count, ladder.length) - 1] ?? ladder[ladder.length - 1];
		return this.now() - failure.at >= wait;
	}

	private recordFailure(target: string, error: string, at: number): void {
		const count = this.lastFailure && this.lastFailure.target === target ? this.lastFailure.count + 1 : 1;
		this.lastFailure = { at: Number.isFinite(at) ? at : this.now(), target, error: boundedError(error), count };
	}

	private async fail(target: string, error: string, from: string): Promise<void> {
		this.recordFailure(target, error, this.now());
		this.waitingLoggedFor = null;
		// Logged once per failure (the ladder spaces them out), with the command to run by hand.
		this.options.logger.warn(
			`Self-update to ${target} failed: ${error}. ${from} keeps running; run \`npm install -g ${SELF_UPDATE_PACKAGE}@${target}\` yourself, then restart the node service.`
		);
		await this.persist({
			version: 1,
			outcome: 'failed',
			at: new Date(this.lastFailure!.at).toISOString(),
			fromVersion: from,
			targetVersion: target,
			error: this.lastFailure!.error
		});
	}

	private async persist(record: SelfUpdateRecord): Promise<void> {
		if (!this.options.persist) return;
		try {
			await this.options.persist(record);
		} catch (error) {
			this.options.logger.warn(
				`Could not record the self-update outcome: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}
