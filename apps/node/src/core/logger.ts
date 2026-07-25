/**
 * Redacting logger.
 *
 * The node holds two long-lived credentials (the one-time enrollment token and
 * the heartbeat secret). Neither may ever reach a log sink — not in a message,
 * not inside a serialized error, not inside a URL. Rather than relying on every
 * call site to remember that, callers `protect()` a credential once and the
 * logger scrubs it out of everything it emits.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
	level: LogLevel;
	message: string;
	at: number;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	/** Register a credential that must never appear in output. No-op for short/empty values. */
	protect(value: string | null | undefined): void;
	/** Scrub every protected value out of arbitrary text. */
	redact(text: string): string;
}

export const REDACTED = '[redacted]';

/**
 * Values shorter than this are not scrubbed: a 2-character "secret" would
 * shred every message it happened to appear in, and real credentials here are
 * 43-character base64url strings (32 random bytes).
 */
export const MIN_PROTECTED_LENGTH = 8;

export interface LoggerOptions {
	sink?: LogSink;
	now?: () => number;
}

/** Default sink: info/warn to stdout, error to stderr, one line per entry. */
export const consoleSink: LogSink = (entry) => {
	const line = `[${new Date(entry.at).toISOString()}] ${entry.level.toUpperCase()} ${entry.message}`;
	if (entry.level === 'error') {
		process.stderr.write(`${line}\n`);
	} else {
		process.stdout.write(`${line}\n`);
	}
};

export function createLogger(options: LoggerOptions = {}): Logger {
	const sink = options.sink ?? consoleSink;
	const now = options.now ?? (() => Date.now());
	const protectedValues = new Set<string>();

	const redact = (text: string): string => {
		let output = text;
		for (const value of protectedValues) {
			// split/join rather than RegExp: credentials are base64url and would
			// otherwise need escaping, and a bad escape is a silent leak.
			output = output.split(value).join(REDACTED);
		}
		return output;
	};

	const emit = (level: LogLevel, message: string): void => {
		sink({ level, message: redact(message), at: now() });
	};

	return {
		info: (message) => emit('info', message),
		warn: (message) => emit('warn', message),
		error: (message) => emit('error', message),
		protect: (value) => {
			if (typeof value === 'string' && value.length >= MIN_PROTECTED_LENGTH) {
				protectedValues.add(value);
			}
		},
		redact
	};
}

/** A logger that keeps the last N entries in memory — used by the desktop status pane. */
export interface BufferedLogger extends Logger {
	entries(): LogEntry[];
}

export function createBufferedLogger(limit = 500, options: LoggerOptions = {}): BufferedLogger {
	const buffer: LogEntry[] = [];
	const base = createLogger({
		now: options.now,
		sink: (entry) => {
			buffer.push(entry);
			if (buffer.length > limit) {
				buffer.splice(0, buffer.length - limit);
			}
			options.sink?.(entry);
		}
	});
	return { ...base, entries: () => [...buffer] };
}
