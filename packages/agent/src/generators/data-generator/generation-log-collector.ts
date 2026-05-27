import type {
    GenerationStepLog,
    GenerationLogLevel,
    GenerationLogSource,
} from '@ever-works/contracts/api';

const RECENT_LOG_LIMIT = 100;
const AUTO_FLUSH_INTERVAL_MS = 1_000;
/** Maximum entries kept in the recent ring buffer for live UI */
const MAX_RECENT_ENTRIES = RECENT_LOG_LIMIT;

export type FlushFn = (historyId: string, logs: GenerationStepLog[]) => Promise<void>;
export type RecentLogsUpdatedFn = (logs: GenerationStepLog[]) => Promise<void>;

type GenerationLogCollectorOptions = {
    onRecentLogsUpdated?: RecentLogsUpdatedFn;
};

/**
 * Pipeline log buffer with two parallel lifecycles:
 *
 * - `buffer` is the **write-behind queue** — entries accumulate here and
 *   are flushed to `flushFn` every {@link AUTO_FLUSH_INTERVAL_MS} ms (1s)
 *   or on demand via `flush()`/`dispose()`. After flushing, `buffer` is
 *   emptied; the entries live on in the DB.
 * - `recentRing` is the **live-UI tail** — the most recent
 *   {@link MAX_RECENT_ENTRIES} (100) entries, never cleared by flush, so
 *   `getRecentLogs()` returns a stable view even right after a flush
 *   reset the write-behind queue. `onRecentLogsUpdated` is invoked every
 *   flush with the current ring snapshot.
 *
 * **Side-effect on construction**: starts the auto-flush
 * `setInterval`. The handle is `.unref()`'d so it won't keep a Node
 * process alive on its own, but **`dispose()` must still be called**
 * during teardown — otherwise the interval continues firing and any
 * residual `buffer` entries from the final write are flushed only when
 * Node next decides to run the timer.
 *
 * `flush()` failures inside the auto-flush tick are swallowed
 * (`.catch(() => {})`) so a transient DB blip doesn't crash the
 * timer; the next tick retries.
 */
export class GenerationLogCollector {
    /** Pending entries waiting to be flushed to DB */
    private buffer: GenerationStepLog[] = [];
    /** Rolling window of recent entries for live UI (never cleared by flush) */
    private recentRing: GenerationStepLog[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly historyId: string,
        private readonly flushFn: FlushFn,
        private readonly options: GenerationLogCollectorOptions = {},
    ) {
        this.flushTimer = setInterval(() => {
            this.flush().catch(() => {});
        }, AUTO_FLUSH_INTERVAL_MS);
        this.flushTimer.unref?.();
    }

    log(entry: GenerationStepLog): void {
        this.buffer.push(entry);
        this.recentRing.push(entry);
        if (this.recentRing.length > MAX_RECENT_ENTRIES) {
            this.recentRing = this.recentRing.slice(-MAX_RECENT_ENTRIES);
        }
    }

    stepStarted(
        stepIndex: number,
        stepName: string,
        source: GenerationLogSource = 'pipeline',
    ): void {
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

    stepCompleted(
        stepIndex: number,
        stepName: string,
        durationMs?: number,
        source: GenerationLogSource = 'pipeline',
    ): void {
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

    stepFailed(
        stepIndex: number,
        stepName: string,
        errorMessage: string,
        source: GenerationLogSource = 'pipeline',
    ): void {
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

    message(
        msg: string,
        level: GenerationLogLevel = 'info',
        source: GenerationLogSource = 'system',
    ): void {
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
    getRecentLogs(n: number = RECENT_LOG_LIMIT): GenerationStepLog[] {
        return this.recentRing.slice(-n);
    }

    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;

        const toFlush = [...this.buffer];
        this.buffer = [];

        await Promise.all([
            this.flushFn(this.historyId, toFlush),
            this.options.onRecentLogsUpdated?.(this.getRecentLogs()),
        ]);
    }

    async dispose(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }
}
