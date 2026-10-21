import type { FleetLogsNoticeKind } from '@ever-works/contracts';
import type { RawLogLine } from './log-io';

/**
 * Logs on computers (FL-08) — what every reader (journal, unified log, event
 * log, file, container, service) answers to the channel. A reader knows
 * nothing about the link, the scan or the pace: it produces raw lines; the
 * channel (`log-channel.ts`) scans, frames and paces them.
 */

export interface LogBatch {
	/** Oldest first. */
	lines: RawLogLine[];
	/** Fewer lines than asked because the scan limit was reached (a file's last 8 MiB). */
	scanLimited?: boolean;
	/** Something to say before the batch completes (only this user's journal entries, U5). */
	notice?: { kind: FleetLogsNoticeKind; hint?: string };
}

export interface LogFollowSink {
	line(line: RawLogLine): void;
	notice(kind: FleetLogsNoticeKind, hint?: string): void;
	/** The follow ended on its own (source gone, container stopped, reader exited): no more lines come. */
	ended(): void;
}

export interface LogFollowHandle {
	stop(): void;
}

export interface LogReader {
	/** The source can page back (`logs.earlier`, P2). */
	readonly supportsEarlier: boolean;
	/** The last `lines` lines. Throws `LogReadError` for a typed refusal. */
	tail(lines: number): Promise<LogBatch>;
	/** Live lines from the end of the last tail on. Never throws: failures reach the sink. */
	follow(sink: LogFollowSink): LogFollowHandle;
	/**
	 * P2 — the `lines` lines before the oldest line this reader has handed out
	 * (its own cursor). Absent when {@link supportsEarlier} is false.
	 */
	earlier?(lines: number): Promise<{ lines: RawLogLine[]; hasMore: boolean }>;
}
