import type { GenerationStepLog, GenerationLogLevel, GenerationLogSource } from '@ever-works/contracts/api';

const DEFAULT_RECENT_COUNT = 20;
const AUTO_FLUSH_INTERVAL_MS = 5_000;
/** Maximum entries kept in the recent ring buffer for live UI */
const MAX_RECENT_ENTRIES = 50;

export type FlushFn = (historyId: string, logs: GenerationStepLog[]) => Promise<void>;

export class GenerationLogCollector {
	/** Pending entries waiting to be flushed to DB */
	private buffer: GenerationStepLog[] = [];
	/** Rolling window of recent entries for live UI (never cleared by flush) */
	private recentRing: GenerationStepLog[] = [];
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly historyId: string,
		private readonly flushFn: FlushFn,
	) {
		this.flushTimer = setInterval(() => {
			this.flush().catch(() => {});
		}, AUTO_FLUSH_INTERVAL_MS);
	}

	log(entry: GenerationStepLog): void {
		this.buffer.push(entry);
		this.recentRing.push(entry);
		if (this.recentRing.length > MAX_RECENT_ENTRIES) {
			this.recentRing = this.recentRing.slice(-MAX_RECENT_ENTRIES);
		}
	}

	stepStarted(stepIndex: number, stepName: string, source: GenerationLogSource = 'pipeline'): void {
		this.log({
			timestamp: new Date().toISOString(),
			level: 'info',
			source,
			stepIndex,
			stepName,
			event: 'step_started',
			message: `Step started: ${stepName}`,
		});
	}

	stepCompleted(stepIndex: number, stepName: string, durationMs?: number, source: GenerationLogSource = 'pipeline'): void {
		this.log({
			timestamp: new Date().toISOString(),
			level: 'info',
			source,
			stepIndex,
			stepName,
			event: 'step_completed',
			message: `Step completed: ${stepName}`,
			durationMs: durationMs ?? null,
		});
	}

	stepFailed(stepIndex: number, stepName: string, errorMessage: string, source: GenerationLogSource = 'pipeline'): void {
		this.log({
			timestamp: new Date().toISOString(),
			level: 'error',
			source,
			stepIndex,
			stepName,
			event: 'step_failed',
			message: `Step failed: ${stepName} — ${errorMessage}`,
		});
	}

	message(msg: string, level: GenerationLogLevel = 'info', source: GenerationLogSource = 'system'): void {
		this.log({
			timestamp: new Date().toISOString(),
			level,
			source,
			event: 'message',
			message: msg,
		});
	}

	/**
	 * Returns the most recent N log entries for live UI display.
	 * This reads from a rolling ring buffer that is NOT cleared by flush().
	 */
	getRecentLogs(n: number = DEFAULT_RECENT_COUNT): GenerationStepLog[] {
		return this.recentRing.slice(-n);
	}

	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;

		const toFlush = [...this.buffer];
		this.buffer = [];

		await this.flushFn(this.historyId, toFlush);
	}

	async dispose(): Promise<void> {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flush();
	}
}
