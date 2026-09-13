import { describe, expect, it } from 'vitest';
import { REDACTED, createBufferedLogger, createLogger, type LogEntry } from './logger';

/** The credential shapes the platform actually mints: 32 random bytes, base64url. */
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';

function capture() {
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry), now: () => 1_700_000_000_000 });
	return { entries, logger, text: () => entries.map((entry) => entry.message).join('\n') };
}

describe('createLogger redaction', () => {
	it('never lets a protected secret reach the sink, at any level', () => {
		const { logger, entries, text } = capture();
		logger.protect(SECRET);

		logger.info(`heartbeat with secret=${SECRET}`);
		logger.warn(`retrying, secret=${SECRET} still stored`);
		logger.error(`POST /api/fleet/heartbeat failed for ${SECRET}`);

		expect(entries).toHaveLength(3);
		expect(text()).not.toContain(SECRET);
		expect(entries[0].message).toBe(`heartbeat with secret=${REDACTED}`);
		expect(entries[2].level).toBe('error');
	});

	it('redacts every protected credential, including several in one message', () => {
		const { logger, text } = capture();
		logger.protect(TOKEN);
		logger.protect(SECRET);

		logger.info(`enroll token=${TOKEN} -> secret=${SECRET} (token=${TOKEN} again)`);

		expect(text()).not.toContain(TOKEN);
		expect(text()).not.toContain(SECRET);
		expect(text()).toBe(`enroll token=${REDACTED} -> secret=${REDACTED} (token=${REDACTED} again)`);
	});

	it('ignores empty, null and implausibly short values so ordinary text survives', () => {
		const { logger, text } = capture();
		logger.protect('');
		logger.protect(null);
		logger.protect(undefined);
		logger.protect('ab');

		logger.info('node ab is online');

		expect(text()).toBe('node ab is online');
	});

	it('exposes redact() so callers can scrub text they do not log directly', () => {
		const { logger } = capture();
		logger.protect(SECRET);
		expect(logger.redact(`connect failed: ${SECRET}`)).toBe(`connect failed: ${REDACTED}`);
	});

	// REGRESSION — the protected set had no eviction path (slice AM review, F3).
	//
	// That is correct for the two credentials this process holds for its
	// whole life, and wrong for a per-run one: the scoped push token was
	// protected on every mint and never dropped, so a node running forty
	// agent-tasks across a multi-day uptime accumulated forty raw
	// `contents: write` installation tokens in a process-lifetime closure —
	// recoverable from a heap snapshot or a crash dump, and the recent ones
	// still live at GitHub. `unprotect()` is what lets the owner of a
	// short-lived credential say when it stops existing.
	it('forgets a per-run credential on unprotect, and keeps the rest', () => {
		const { logger, text } = capture();
		logger.protect(SECRET);
		logger.protect(TOKEN);

		logger.unprotect(TOKEN);

		logger.info(`run over: token=${TOKEN} secret=${SECRET}`);
		// The long-lived secret is still scrubbed; only the value whose
		// owner declared it dead comes back through.
		expect(text()).toBe(`run over: token=${TOKEN} secret=${REDACTED}`);
	});

	it('is safe to unprotect a value that was never protected, or none at all', () => {
		const { logger, text } = capture();
		logger.protect(SECRET);

		logger.unprotect('never-registered-value');
		logger.unprotect(null);
		logger.unprotect(undefined);
		// Idempotent: the second call has nothing left to remove.
		logger.unprotect(SECRET);
		logger.unprotect(SECRET);

		logger.info(`secret=${SECRET}`);
		expect(text()).toBe(`secret=${SECRET}`);
	});
});

describe('createBufferedLogger', () => {
	it('keeps the last N redacted entries for the status pane', () => {
		const buffered = createBufferedLogger(3, { now: () => 1 });
		buffered.protect(SECRET);
		buffered.info('one');
		buffered.info('two');
		buffered.info(`three ${SECRET}`);
		buffered.info('four');

		const entries = buffered.entries();
		expect(entries.map((entry) => entry.message)).toEqual(['two', `three ${REDACTED}`, 'four']);
		expect(JSON.stringify(entries)).not.toContain(SECRET);
	});
});
