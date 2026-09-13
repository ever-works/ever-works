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
		this.source = await this.options.backend.start({ profileDir: this.options.profileDir });
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
		this.running = false;
		this.clearTimer('captureTimer');
		this.clearTimer('statsTimer');
		const source = this.source;
		this.source = null;
		await source?.stop();
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
			this.source ??= await this.options.backend.start({ profileDir: this.options.profileDir });
			const picture = await this.source.capture({ width: preset.width, quality: preset.q });
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
			if (!this.running && this.source) {
				// Stopped while this tick was starting a source: release it.
				const orphan = this.source;
				this.source = null;
				void orphan.stop();
			}
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
			this.source = await this.options.backend.start({ profileDir: this.options.profileDir });
			this.forceNext = true;
		} catch (error) {
			this.options.logger?.warn(
				`Live view capture could not restart: ${error instanceof Error ? error.message : String(error)}`
			);
			// Try again on the next tick rather than ending the view.
		}
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
