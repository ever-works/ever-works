import {
	COMPUTER_QUALITY_PRESETS,
	fleetHelperFingerprintPrefix,
	FLEET_DESKTOP_VIEWS_PER_NODE,
	FLEET_DESKTOP_WATCH_REASONS,
	FLEET_HELPER_SCREEN_CAPABILITY,
	FLEET_SCREEN_DESKTOP_CAPABILITY,
	type ComputerQuality,
	type FleetDesktopReason,
	type FleetDisplayView,
	type FleetHelperEvent,
	type FleetHelperStatusView,
	type FleetHelperTrust
} from '@ever-works/contracts';
import type { Logger } from '../logger';
import {
	HELPER_MESSAGES,
	encodeHelperJson,
	encodeHelperMessage,
	helperStartMessage,
	parseHelperDisplays,
	parseHelperError,
	parseHelperFrame,
	parseHelperHello,
	parseHelperStarted,
	acceptHelperTiles,
	type HelperDisplays,
	type HelperError,
	type HelperFrame,
	type HelperHello,
	type HelperStarted,
	type HelperStreamSettings
} from './helper/helper-protocol';
import { HelperProcess, helperEnvironment, type HelperSpawner } from './helper/helper-process';
import {
	appendHelperEvent,
	readHelperEvents,
	readHelperPolicy,
	verifyHelper,
	type HelperFs,
	type HelperPaths,
	type HelperVerification
} from './helper/helper-trust';

/**
 * Desktop view & control (FL-07, plan §6.1) — the node's host for the native
 * screen helper: what the machine can say about its desktop, and the streams
 * that show it.
 *
 * One {@link DesktopHelperStream} per desktop view: each view gets its own
 * helper process, started only after the helper was verified against the
 * owner's admission record a moment before (FR-14). The host also keeps the
 * facts the heartbeat reports (`helperTrust`, `helper`, `displays`,
 * `desktopReasons`, `helperEvents`) and the tags it advertises
 * (`helper:screen`, `screen:desktop`), from the last verification and the last
 * `hello` a helper sent (a short probe refreshes them every few minutes).
 *
 * Revoking the admission (`ever-works-node helper revoke`, from another
 * process) is noticed within a second while a stream runs: every stream ends
 * at once, closed `node-unavailable` (FR-19).
 *
 * Input is not here: watching is read-only in P1 (control is P2).
 */

/** A helper that has not said `hello` within this long is stopped. */
export const HELPER_HELLO_TIMEOUT_MS = 5_000;
/** A `start` the helper has not answered within this long fails. */
export const HELPER_START_TIMEOUT_MS = 5_000;
/** The facts are re-probed this often when no stream refreshes them. */
export const HELPER_PROBE_EVERY_MS = 5 * 60_000;
/** While a stream runs, the admission record is re-read this often (FR-19: revoke stops it within 2 s). */
export const HELPER_POLICY_WATCH_MS = 1_000;
/** Unexpected helper exits tolerated per window before opens are refused for the rest of it. */
export const HELPER_CRASH_LIMIT = 3;
export const HELPER_CRASH_WINDOW_MS = 60_000;

/** The stream settings for a quality preset (AW-11's numbers, FR-7). */
export function helperSettingsFor(quality: ComputerQuality): HelperStreamSettings {
	const preset = COMPUTER_QUALITY_PRESETS[quality];
	return { width: preset.width, quality: preset.q, maxFps: preset.maxFps, keyframeMs: preset.keyframeMs };
}

/** What the heartbeat carries about the desktop (CONTRACTS §1.1). */
export interface DesktopHelperReport {
	helperTrust: FleetHelperTrust;
	helper: FleetHelperStatusView;
	displays: FleetDisplayView[];
	desktopReasons: FleetDesktopReason[];
	helperEvents: FleetHelperEvent[];
}

export interface DesktopStreamHandlers {
	onFrame(frame: HelperFrame): void;
	onTiles(payload: Uint8Array): void;
	onDisplays(displays: HelperDisplays): void;
	onError(error: HelperError): void;
	/** The stream ended — the helper exited, or the host stopped it (`reason` names why). */
	onEnded(reason: DesktopStreamEnd): void;
}

export type DesktopStreamEnd = 'stopped' | 'revoked' | 'helper-exited' | 'kill-switch';

export interface DesktopStreamRequest {
	display: string | null;
	quality: ComputerQuality;
}

/** Why a stream could not open. */
export type DesktopStreamRefusal =
	| { kind: 'reason'; reason: FleetDesktopReason }
	| { kind: 'limit' }
	| { kind: 'crashing' }
	| { kind: 'failed'; message: string };

export interface DesktopHelperStream {
	readonly started: HelperStarted;
	setQuality(quality: ComputerQuality): void;
	refresh(): void;
	/** Switch display; resolves with what the helper answered. */
	setDisplay(display: string): Promise<{ ok: true; started: HelperStarted } | { ok: false; error: HelperError }>;
	listDisplays(): Promise<FleetDisplayView[]>;
	stop(): void;
}

export interface DesktopHelperHostOptions {
	paths: HelperPaths;
	fs: HelperFs;
	platform: string;
	env: Readonly<Record<string, string | undefined>>;
	spawner?: HelperSpawner;
	logger?: Logger;
	now?: () => number;
	/** Most streams at once (default: the per-computer view cap). */
	maxStreams?: number;
}

interface Waiter<T> {
	resolve(value: T): void;
	timer: ReturnType<typeof setTimeout>;
}

export class DesktopHelperHost {
	private verification: HelperVerification | null = null;
	private hello: HelperHello | null = null;
	private lastProbeAt = -Infinity;
	private probing: Promise<void> | null = null;
	private readonly streams = new Set<StreamRecord>();
	private crashes: number[] = [];
	private watchTimer: ReturnType<typeof setInterval> | null = null;
	/** The verify-failed event already recorded for this record (once per admission, not per beat). */
	private recordedFailureFor: string | null = null;
	private readonly now: () => number;

	constructor(private readonly options: DesktopHelperHostOptions) {
		this.now = options.now ?? (() => Date.now());
	}

	/** Re-verify the helper and, when admitted and stale, re-probe its facts. Never throws. */
	async refresh(): Promise<void> {
		try {
			const verification = await verifyHelper(this.options.fs, this.options.paths, this.now);
			await this.noteVerification(verification);
			if (!verification.ok) {
				this.hello = null;
				return;
			}
			if (this.streams.size === 0 && this.now() - this.lastProbeAt >= HELPER_PROBE_EVERY_MS) {
				await this.probe(verification);
			}
		} catch (error) {
			this.options.logger?.warn(
				`Screen helper check failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** The tags this machine advertises for its desktop (CONTRACTS §1.2). Sync, from the last refresh. */
	tags(): string[] {
		if (!this.verification?.ok) return [];
		const tags = [FLEET_HELPER_SCREEN_CAPABILITY];
		const reasons = this.reasons();
		if (this.hello && !reasons.some((reason) => FLEET_DESKTOP_WATCH_REASONS.includes(reason))) {
			tags.push(FLEET_SCREEN_DESKTOP_CAPABILITY);
		}
		return tags;
	}

	/** Why the Desktop source is unavailable right now (empty when it is available). */
	reasons(): FleetDesktopReason[] {
		const verification = this.verification;
		if (!verification) return ['helper-missing'];
		if (!verification.ok) return [verification.reason];
		return this.hello ? [...this.hello.reasons] : [];
	}

	/** The heartbeat's desktop fields. */
	async report(): Promise<DesktopHelperReport> {
		const verification = this.verification;
		const record = verification?.record ?? null;
		const trust: FleetHelperTrust = verification?.ok ? verification.trust : 'none';
		return {
			helperTrust: trust,
			helper: {
				trust,
				present: verification ? (verification.ok ? true : verification.present) : false,
				admitted: record !== null,
				version: this.hello?.version ?? record?.version ?? null,
				fingerprintPrefix: record ? fleetHelperFingerprintPrefix(record.sha256) : null,
				verifiedAt: verification?.ok ? verification.verifiedAt : null,
				published: record ? record.published : null
			},
			displays: this.hello?.displays ?? [],
			desktopReasons: this.reasons(),
			helperEvents: await readHelperEvents(this.options.fs, this.options.paths.eventsPath)
		};
	}

	get liveStreams(): number {
		return this.streams.size;
	}

	/** Open a stream of one display; every refusal is typed. */
	async openStream(
		request: DesktopStreamRequest,
		handlers: DesktopStreamHandlers
	): Promise<{ ok: true; stream: DesktopHelperStream } | { ok: false; refusal: DesktopStreamRefusal }> {
		if (this.streams.size >= (this.options.maxStreams ?? FLEET_DESKTOP_VIEWS_PER_NODE)) {
			return { ok: false, refusal: { kind: 'limit' } };
		}
		const nowMs = this.now();
		this.crashes = this.crashes.filter((at) => nowMs - at < HELPER_CRASH_WINDOW_MS);
		if (this.crashes.length >= HELPER_CRASH_LIMIT) return { ok: false, refusal: { kind: 'crashing' } };
		// FR-14: verified immediately before this start, every time.
		const verification = await verifyHelper(this.options.fs, this.options.paths, this.now);
		await this.noteVerification(verification);
		if (!verification.ok) return { ok: false, refusal: { kind: 'reason', reason: verification.reason } };

		const record: StreamRecord = new StreamRecord(this, verification.record.sha256, handlers);
		const helper = HelperProcess.start(
			verification.record.path,
			helperEnvironment(this.options.env, this.options.platform),
			{
				onMessage: (message) => record.onMessage(message.kind, message.payload),
				onExit: () => record.onExit()
			},
			{ ...(this.options.spawner ? { spawner: this.options.spawner } : {}), ...(this.options.logger ? { logger: this.options.logger } : {}) }
		);
		record.helper = helper;
		const hello = await record.waitHello(HELPER_HELLO_TIMEOUT_MS);
		if (!hello) {
			helper.stop('no hello');
			return { ok: false, refusal: { kind: 'failed', message: 'the screen helper did not answer' } };
		}
		this.hello = hello;
		this.lastProbeAt = this.now();
		const blocking = hello.reasons.find((reason) => FLEET_DESKTOP_WATCH_REASONS.includes(reason));
		if (blocking) {
			helper.stop('blocked');
			return { ok: false, refusal: { kind: 'reason', reason: blocking } };
		}
		// The waiter first: a helper may answer before `send` returns.
		const answer = record.waitStarted(HELPER_START_TIMEOUT_MS);
		helper.send(helperStartMessage(request.display, helperSettingsFor(request.quality)));
		const started = await answer;
		if (!started || 'code' in started) {
			helper.stop('start failed');
			return {
				ok: false,
				refusal: {
					kind: 'failed',
					message: started ? started.message || started.code : 'the screen helper did not start the picture'
				}
			};
		}
		record.started = started;
		this.streams.add(record);
		this.ensureWatch();
		return { ok: true, stream: record.handle() };
	}

	/** End every stream (node shutdown, kill switch). */
	stopAll(reason: DesktopStreamEnd): void {
		for (const record of [...this.streams]) record.end(reason);
	}

	/** Called by a stream when its helper exited or it was stopped. */
	forget(record: StreamRecord, crashed: boolean): void {
		this.streams.delete(record);
		if (crashed) this.crashes.push(this.now());
		if (this.streams.size === 0 && this.watchTimer) {
			clearInterval(this.watchTimer);
			this.watchTimer = null;
		}
	}

	/** A helper's own report updates the facts the heartbeat carries. */
	noteHello(hello: HelperHello): void {
		this.hello = hello;
		this.lastProbeAt = this.now();
	}

	noteDisplays(displays: FleetDisplayView[]): void {
		if (this.hello) this.hello = { ...this.hello, displays };
	}

	private ensureWatch(): void {
		if (this.watchTimer) return;
		this.watchTimer = setInterval(() => void this.watchPolicy(), HELPER_POLICY_WATCH_MS);
		this.watchTimer.unref?.();
	}

	/** FR-19: the record gone or replaced ends every stream at once. */
	private async watchPolicy(): Promise<void> {
		if (this.streams.size === 0) return;
		const policy = await readHelperPolicy(this.options.fs, this.options.paths.policyPath);
		for (const record of [...this.streams]) {
			if (!policy || policy.sha256 !== record.admittedSha256) record.end('revoked');
		}
		if (!policy) {
			this.verification = { ok: false, reason: 'helper-unadmitted', record: null, present: true };
			this.hello = null;
		}
	}

	private async probe(verification: Extract<HelperVerification, { ok: true }>): Promise<void> {
		if (this.probing) return this.probing;
		this.probing = (async () => {
			let resolveHello: (hello: HelperHello | null) => void = () => undefined;
			const helloPromise = new Promise<HelperHello | null>((resolve) => {
				resolveHello = resolve;
			});
			const helper = HelperProcess.start(
				verification.record.path,
				helperEnvironment(this.options.env, this.options.platform),
				{
					onMessage: (message) => {
						if (message.kind === HELPER_MESSAGES.hello) resolveHello(parseHelperHello(message.payload));
					},
					onExit: () => resolveHello(null)
				},
				{ ...(this.options.spawner ? { spawner: this.options.spawner } : {}), ...(this.options.logger ? { logger: this.options.logger } : {}) }
			);
			const timer = setTimeout(() => resolveHello(null), HELPER_HELLO_TIMEOUT_MS);
			const hello = await helloPromise;
			clearTimeout(timer);
			helper.stop('probe done');
			this.lastProbeAt = this.now();
			if (hello) this.hello = hello;
		})().finally(() => {
			this.probing = null;
		});
		return this.probing;
	}

	/** Remember the verification; record one `verify-failed` event per failing admission (U3). */
	private async noteVerification(verification: HelperVerification): Promise<void> {
		this.verification = verification;
		if (verification.ok) {
			this.recordedFailureFor = null;
			return;
		}
		if (verification.reason !== 'helper-untrusted' && !(verification.reason === 'helper-missing' && verification.record)) {
			return;
		}
		const key = `${verification.record?.acknowledgedAt ?? ''}:${verification.reason}`;
		if (this.recordedFailureFor === key) return;
		this.recordedFailureFor = key;
		this.options.logger?.warn(
			verification.reason === 'helper-untrusted'
				? 'The screen helper has changed since it was approved; it will not be started until it is approved again (ever-works-node helper status)'
				: 'The approved screen helper file is gone; run ever-works-node helper install'
		);
		await appendHelperEvent(
			this.options.fs,
			this.options.paths.eventsPath,
			{
				kind: 'verify-failed',
				reason: verification.reason,
				fingerprintPrefix: verification.record ? fleetHelperFingerprintPrefix(verification.record.sha256) : null,
				version: verification.record?.version ?? null
			},
			this.now
		);
	}
}

/** One stream's state (internal). */
class StreamRecord {
	helper: HelperProcess | null = null;
	started: HelperStarted | null = null;
	private ended = false;
	private helloWaiter: Waiter<HelperHello | null> | null = null;
	private startWaiter: Waiter<HelperStarted | HelperError | null> | null = null;
	private displayWaiters: Array<Waiter<FleetDisplayView[]>> = [];

	constructor(
		private readonly host: DesktopHelperHost,
		readonly admittedSha256: string,
		private readonly handlers: DesktopStreamHandlers
	) {}

	waitHello(ms: number): Promise<HelperHello | null> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.settleHello(null), ms);
			timer.unref?.();
			this.helloWaiter = { resolve, timer };
		});
	}

	waitStarted(ms: number): Promise<HelperStarted | HelperError | null> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.settleStart(null), ms);
			timer.unref?.();
			this.startWaiter = { resolve, timer };
		});
	}

	onMessage(kind: number, payload: Uint8Array): void {
		switch (kind) {
			case HELPER_MESSAGES.hello: {
				const hello = parseHelperHello(payload);
				if (hello) this.host.noteHello(hello);
				this.settleHello(hello);
				return;
			}
			case HELPER_MESSAGES.started: {
				const started = parseHelperStarted(payload);
				if (!started) return;
				// Pictures follow `started` at once: accept them from this moment.
				this.started = started;
				this.settleStart(started);
				return;
			}
			case HELPER_MESSAGES.error: {
				const error = parseHelperError(payload);
				if (!error) return;
				if (this.startWaiter) {
					this.settleStart(error);
					return;
				}
				if (this.ended) return;
				this.handlers.onError(error);
				return;
			}
			case HELPER_MESSAGES.frame: {
				if (this.ended || !this.started) return;
				const frame = parseHelperFrame(payload);
				if (frame) this.handlers.onFrame(frame);
				return;
			}
			case HELPER_MESSAGES.tiles: {
				if (this.ended || !this.started) return;
				const tiles = acceptHelperTiles(payload);
				if (tiles) this.handlers.onTiles(tiles);
				return;
			}
			case HELPER_MESSAGES.displays: {
				const displays = parseHelperDisplays(payload);
				if (!displays) return;
				this.host.noteDisplays(displays.displays);
				const waiters = this.displayWaiters;
				this.displayWaiters = [];
				for (const waiter of waiters) {
					clearTimeout(waiter.timer);
					waiter.resolve(displays.displays);
				}
				if (!this.ended && this.started) this.handlers.onDisplays(displays);
				return;
			}
			default:
				return;
		}
	}

	onExit(): void {
		this.settleHello(null);
		this.settleStart(null);
		for (const waiter of this.displayWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve([]);
		}
		this.displayWaiters = [];
		if (this.ended) return;
		this.ended = true;
		const wasStreaming = this.started !== null;
		this.host.forget(this, wasStreaming);
		if (wasStreaming) this.handlers.onEnded('helper-exited');
	}

	/** End the stream on the node's own decision. */
	end(reason: DesktopStreamEnd): void {
		if (this.ended) return;
		this.ended = true;
		this.helper?.stop(reason);
		this.host.forget(this, false);
		this.handlers.onEnded(reason);
	}

	handle(): DesktopHelperStream {
		const started = this.started as HelperStarted;
		return {
			started,
			setQuality: (quality) => {
				this.helper?.send(encodeHelperJson(HELPER_MESSAGES.quality, { ...helperSettingsFor(quality) }));
			},
			refresh: () => {
				this.helper?.send(encodeHelperMessage(HELPER_MESSAGES.refresh));
			},
			setDisplay: (display) =>
				new Promise((resolve) => {
					if (!this.helper || this.ended) {
						resolve({ ok: false, error: { code: 'invalid', message: 'the stream has ended' } });
						return;
					}
					const timer = setTimeout(() => {
						this.startWaiter = null;
						resolve({ ok: false, error: { code: 'timeout', message: 'the screen helper did not switch display' } });
					}, HELPER_START_TIMEOUT_MS);
					timer.unref?.();
					this.startWaiter = {
						timer,
						resolve: (answer) => {
							if (answer && !('code' in answer)) {
								this.started = answer;
								resolve({ ok: true, started: answer });
							} else {
								resolve({
									ok: false,
									error: answer ?? { code: 'timeout', message: 'the screen helper did not switch display' }
								});
							}
						}
					};
					this.helper.send(encodeHelperJson(HELPER_MESSAGES.setDisplay, { display }));
				}),
			listDisplays: () =>
				new Promise((resolve) => {
					if (!this.helper || this.ended) {
						resolve([]);
						return;
					}
					const timer = setTimeout(() => {
						this.displayWaiters = this.displayWaiters.filter((waiter) => waiter.timer !== timer);
						resolve(this.started?.displays ?? []);
					}, HELPER_START_TIMEOUT_MS);
					timer.unref?.();
					this.displayWaiters.push({ resolve, timer });
					this.helper.send(encodeHelperMessage(HELPER_MESSAGES.listDisplays));
				}),
			stop: () => this.end('stopped')
		};
	}

	private settleHello(hello: HelperHello | null): void {
		const waiter = this.helloWaiter;
		if (!waiter) return;
		this.helloWaiter = null;
		clearTimeout(waiter.timer);
		waiter.resolve(hello);
	}

	private settleStart(answer: HelperStarted | HelperError | null): void {
		const waiter = this.startWaiter;
		if (!waiter) return;
		this.startWaiter = null;
		clearTimeout(waiter.timer);
		waiter.resolve(answer);
	}
}
