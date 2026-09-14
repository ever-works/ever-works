import {
	COMPUTER_CAPTURE_RESTART_AFTER_FAILURES,
	COMPUTER_QUALITY_PRESETS,
	isOverLinkLimits,
	lowerComputerQuality,
	shouldDegrade,
	shouldRecover,
	type ComputerNodeToServerFrame,
	type ComputerQuality,
	type ComputerStatsFrame
} from '@ever-works/contracts';
import { systemScheduler, type Scheduler } from '../heartbeat';
import type { Logger } from '../logger';
import type { CaptureBackend, CaptureSource } from './capture-backend';

/**
 * Agent computers — the capture pump: when to take a picture, at what
 * quality, and what to do when pictures stop coming.
 *
 * It owns TIMING and POLICY only. The picture itself comes from whichever
 * {@link CaptureBackend} the machine selected, and every frame goes to the
 * outbox (which scans and batches it), so the pump never touches a socket,
 * a browser or a secret.
 *
 *  - **Quality.** Every number comes from `COMPUTER_QUALITY_PRESETS` and the
 *    link thresholds in `@ever-works/contracts` — nothing is re-declared.
 *    A picture is taken at most `maxFps` times a second; an unchanged
 *    picture is not re-sent until `keyframeMs` has passed (or a refresh).
 *  - **Degrade and recover.** Over the backlog or acknowledgement limit for
 *    the whole degrade window → one tier down (never a skip), and the stats
 *    frame says so; within limits for the recover window → back to the tier
 *    the owner chose.
 *  - **Refresh** takes and sends a picture now, even an unchanged one.
 *  - **Three failed pictures in a row restart the capture source** without
 *    ending the view, and tell the owner it did.
 *  - **Stats** once a second: the machine's own clock (with its offset), the
 *    chosen and effective quality, the rate, the backlog and bytes sent.
 */

export const COMPUTER_STATS_INTERVAL_MS = 1000;

export interface CapturePumpOutbox {
	push(frame: ComputerNodeToServerFrame): boolean;
	backlog(): number;
	lastAckMs(): number;
	bytesOut(): number;
}

export interface CapturePumpOptions {
	backend: CaptureBackend;
	profileDir: string;
	quality: ComputerQuality;
	outbox: CapturePumpOutbox;
	scheduler?: Scheduler;
	now?: () => number;
	/** The machine's wall clock as a Date (injected so the offset is testable). */
	clock?: () => Date;
	logger?: Logger;
}

/** `2026-09-13T09:41:07+03:00` — the machine's local time with its own offset. */
export function formatNodeLocalTime(date: Date): string {
	const pad = (value: number, width = 2) => String(Math.trunc(Math.abs(value))).padStart(width, '0');
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	return (
		`${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`${sign}${pad(offset / 60)}:${pad(offset % 60)}`
	);
}

export class CapturePump {
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly clock: () => Date;
	private source: CaptureSource | null = null;
	private chosen: ComputerQuality;
	private effective: ComputerQuality;
	private captureTimer: unknown = null;
	private statsTimer: unknown = null;
	private running = false;
	/** Set by `stop()` and never cleared: a stopped pump opens nothing again. */
	private stopped = false;
	/**
	 * Source starts still in flight, each settling only once its source is
	 * either installed or — when `stop()` began first — stopped again.
	 * `stop()` waits for all of them, so no capture process outlives it.
	 */
	private readonly opening = new Set<Promise<void>>();
	private capturing = false;
	private forceNext = false;
	private seq = 0;
	private failures = 0;
	private restarts = 0;
	private lastData: string | null = null;
	private lastSentAt = 0;
	private overSince: number | null = null;
	private withinSince: number | null = null;
	private sentTimes: number[] = [];

	constructor(private readonly options: CapturePumpOptions) {
		this.scheduler = options.scheduler ?? systemScheduler;
		this.now = options.now ?? (() => Date.now());
		this.clock = options.clock ?? (() => new Date());
		this.chosen = options.quality;
		this.effective = options.quality;
	}

	/** Open the capture source and begin. Rejects when the source cannot start. */
	async start(): Promise<void> {
		// Stopped while (or before) starting: the source was released inside
		// `openSource`, and nothing is armed.
		if (!(await this.openSource())) return;
		this.running = true;
		this.forceNext = true;
		this.armCapture(0);
		this.armStats();
	}

	/** The owner picked a quality: it becomes both the chosen and the effective tier. */
	setQuality(quality: ComputerQuality): void {
		this.chosen = quality;
		this.effective = quality;
		this.overSince = null;
		this.withinSince = null;
		this.forceNext = true;
	}

	/** Take and send a full picture now. */
	refresh(): void {
		if (!this.running) return;
		this.forceNext = true;
		this.armCapture(0);
	}

	get effectiveQuality(): ComputerQuality {
		return this.effective;
	}

	get restartCount(): number {
		return this.restarts;
	}

	/** Open source, for the profile report. */
	get captureSource(): CaptureSource | null {
		return this.source;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.running = false;
		this.clearTimer('captureTimer');
		this.clearTimer('statsTimer');
		const source = this.source;
		this.source = null;
		// A start still in flight stops its own source when it lands (it sees
		// `stopped`); waiting for it here means this resolves only once every
		// capture process this pump opened is gone.
		await Promise.allSettled([source?.stop(), ...this.opening]);
	}

	/** The stats frame for this instant. */
	stats(): ComputerStatsFrame {
		const cutoff = this.now() - 1000;
		this.sentTimes = this.sentTimes.filter((at) => at > cutoff);
		return {
			kind: 'stats',
			nodeLocalTime: formatNodeLocalTime(this.clock()),
			quality: this.chosen,
			effectiveQuality: this.effective,
			fps: this.sentTimes.length,
			backlog: this.options.outbox.backlog(),
			bytesOut: this.options.outbox.bytesOut()
		};
	}

	/** One capture tick. Exposed for tests; the timer calls it. */
	async tick(): Promise<void> {
		if (!this.running || this.capturing) return;
		this.capturing = true;
		const preset = COMPUTER_QUALITY_PRESETS[this.effective];
		try {
			// A restart that failed left no source: try again here, one tick
			// later, rather than ending a view over a browser that hiccupped.
			if (!this.source && !(await this.openSource())) return;
			const source = this.source;
			if (!source) return;
			const picture = await source.capture({ width: preset.width, quality: preset.q });
			if (!this.running) return;
			this.failures = 0;
			const at = this.now();
			const unchanged = picture.data === this.lastData;
			if (this.forceNext || !unchanged || at - this.lastSentAt >= preset.keyframeMs) {
				this.seq += 1;
				const accepted = this.options.outbox.push({
					kind: 'frame',
					seq: this.seq,
					keyframe: true,
					width: picture.width,
					height: picture.height,
					mime: picture.mime,
					data: picture.data
				});
				if (accepted) {
					this.lastData = picture.data;
					this.lastSentAt = at;
					this.sentTimes.push(at);
					this.forceNext = false;
				} else {
					await this.onFailure('A picture was too large to send.');
				}
			}
		} catch (error) {
			await this.onFailure(error instanceof Error ? error.message : String(error));
		} finally {
			this.capturing = false;
		}
		if (!this.running) return;
		this.adaptQuality();
		if (this.running) {
			this.armCapture(Math.max(1, Math.floor(1000 / COMPUTER_QUALITY_PRESETS[this.effective].maxFps)));
		}
	}

	private async onFailure(detail: string): Promise<void> {
		this.failures += 1;
		if (this.failures < COMPUTER_CAPTURE_RESTART_AFTER_FAILURES || !this.running) return;
		this.options.logger?.warn(`Live view capture failed ${this.failures} times in a row, restarting it: ${detail}`);
		this.failures = 0;
		this.restarts += 1;
		this.options.outbox.push({
			kind: 'error',
			message: 'The picture stopped updating, so the capture was restarted. The view stays open.'
		});
		const previous = this.source;
		this.source = null;
		await previous?.stop();
		try {
			// `openSource` rechecks for a stop that began while the previous
			// source was closing, and releases a source that lands after one.
			if (await this.openSource()) this.forceNext = true;
		} catch (error) {
			this.options.logger?.warn(
				`Live view capture could not restart: ${error instanceof Error ? error.message : String(error)}`
			);
			// Try again on the next tick rather than ending the view.
		}
	}

	/**
	 * Start a capture source and install it as the active one — unless
	 * `stop()` began first, in which case the new source is stopped (and
	 * awaited) here and nothing is installed. The check and the install run
	 * in the same synchronous step after the start resolves, so a stop can
	 * land only before it (this releases the source) or after it (`stop()`
	 * finds and releases it); there is no window in between.
	 *
	 * Resolves true when a source was installed, false when the pump was
	 * stopped; rejects when the backend cannot start.
	 */
	private openSource(): Promise<boolean> {
		if (this.stopped) return Promise.resolve(false);
		const attempt = (async (): Promise<boolean> => {
			const source = await this.options.backend.start({ profileDir: this.options.profileDir });
			if (this.stopped) {
				await source.stop();
				return false;
			}
			this.source = source;
			return true;
		})();
		const settled = attempt.then(
			() => undefined,
			() => undefined
		);
		this.opening.add(settled);
		void settled.then(() => this.opening.delete(settled));
		return attempt;
	}

	private adaptQuality(): void {
		const at = this.now();
		const sample = { backlog: this.options.outbox.backlog(), ackMs: this.options.outbox.lastAckMs() };
		if (isOverLinkLimits(sample)) {
			this.withinSince = null;
			this.overSince ??= at;
			if (shouldDegrade(sample, at - this.overSince) && this.effective !== 'steady') {
				this.effective = lowerComputerQuality(this.effective);
				this.overSince = at;
			}
			return;
		}
		this.overSince = null;
		this.withinSince ??= at;
		if (this.effective !== this.chosen && shouldRecover(sample, at - this.withinSince)) {
			this.effective = this.chosen;
			this.withinSince = at;
			this.forceNext = true;
		}
	}

	private armCapture(delayMs: number): void {
		this.clearTimer('captureTimer');
		this.captureTimer = this.scheduler.setTimeout(() => {
			this.captureTimer = null;
			void this.tick();
		}, delayMs);
	}

	private armStats(): void {
		this.clearTimer('statsTimer');
		this.statsTimer = this.scheduler.setTimeout(() => {
			this.statsTimer = null;
			if (!this.running) return;
			this.options.outbox.push(this.stats());
			this.armStats();
		}, COMPUTER_STATS_INTERVAL_MS);
	}

	private clearTimer(which: 'captureTimer' | 'statsTimer'): void {
		const handle = this[which];
		if (handle !== null) {
			this.scheduler.clearTimeout(handle);
			this[which] = null;
		}
	}
}
