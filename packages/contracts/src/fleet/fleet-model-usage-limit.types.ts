/**
 * Fleet model usage limits — "the model CLI on this machine is out of quota".
 *
 * The defect this closes (prod, 2026-10-17): a Task pinned to an Agent on one
 * PC ran, and Claude Code answered `You've hit your weekly limit · resets
 * Oct 19, 3am (Europe/Paris)` thirty seconds in. The node stayed `online`,
 * kept leasing agent-task jobs that each failed the same way, the Agent's
 * error count climbed until `pauseAfterFailures` halted it, and the owner was
 * told nothing they could act on.
 *
 * A usage limit is not a failure of the work, of the Agent or of the machine:
 * it is a property of the SEAT the CLI on that machine is logged in as, and it
 * ends at a known instant. So it gets its own machine-readable outcome
 * (`failureKind: 'model_usage_limit'` + `retryAfter`) and its own handling:
 *
 *  - the node stops leasing agent-task jobs for THAT CLI until the reset and
 *    says so on its heartbeat (`workerState: 'throttled'`);
 *  - the platform puts the job back in the queue (no attempt spent, no Agent
 *    error counted, no Task failed), keeps the node off that CLI's work until
 *    the reset, and files ONE Inbox notice per node per throttle window.
 *
 * Shared by the node (which recognises the CLI's words) and the API (which
 * re-recognises them from an OLDER node's plain failure result, so the fix is
 * live on deploy, before any machine upgrades). Dependency-free, like the rest
 * of this package: `Intl` is the only time-zone engine it uses.
 */

/** The machine-readable outcome a job result carries for a usage limit. */
export const FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT = 'model_usage_limit' as const;

export type FleetJobFailureKind = typeof FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT;

/**
 * `queuedReason` stamped on a fleet job (and on its AgentRun) while it waits
 * for a model usage limit to reset. A short machine token, like
 * `waiting-for-runner`; the run sweepers exempt it (it is waiting, not stuck).
 */
export const FLEET_JOB_MODEL_USAGE_LIMIT_QUEUED_REASON = 'model-usage-limit';

/** When the CLI named no reset time: retry an hour later. */
export const FLEET_MODEL_USAGE_LIMIT_FALLBACK_MS = 60 * 60 * 1000;

/** Never retry sooner than a minute (a reset "now" is a parse we cannot trust). */
export const FLEET_MODEL_USAGE_LIMIT_MIN_MS = 60 * 1000;

/** Never hold longer than eight days (the longest window, weekly, plus slack). */
export const FLEET_MODEL_USAGE_LIMIT_MAX_MS = 8 * 24 * 60 * 60 * 1000;

/** Margin added after a stated reset instant, so the retry lands after it, not on it. */
export const FLEET_MODEL_USAGE_LIMIT_RESET_SLACK_MS = 60 * 1000;

/**
 * How many times ONE job may be parked for a usage limit before the platform
 * stops refunding its attempt and settles it the ordinary way. A backstop
 * against a mis-recognised failure turning into an endless requeue — a real
 * limit resets long before twenty windows have passed.
 */
export const FLEET_JOB_MAX_USAGE_LIMIT_PARKS = 20;

/** Cap on the CLI's own sentence carried on the result / shown in Fleet. */
export const FLEET_MODEL_USAGE_LIMIT_MAX_MESSAGE_LENGTH = 300;

/**
 * Which window ran out, when the CLI said:
 * - `weekly`  — Claude Code's weekly cap;
 * - `session` — Claude Code's rolling 5-hour window;
 * - `daily`   — a per-day cap;
 * - `rate`    — an HTTP 429 / `rate_limit_error` (short-term throttling);
 * - `usage`   — a usage cap the CLI did not qualify (Codex, older Claude Code).
 */
export type FleetModelUsageLimitWindow = 'weekly' | 'session' | 'daily' | 'rate' | 'usage';

/** What the node (or the API, from an older node's result) recognised. */
export interface FleetModelUsageLimit {
	/** The CLI that ran out — a `FleetAgentExecutionProvider` (`claude-code`, `codex`). */
	provider: string;
	window: FleetModelUsageLimitWindow;
	/** ISO instant the CLI said the limit resets, or null when it named none (or one we could not read). */
	resetsAt: string | null;
	/** ISO instant the work may be retried: `resetsAt` + slack, or the fallback; always clamped. */
	retryAfter: string;
	/** The CLI's own sentence, trimmed to {@link FLEET_MODEL_USAGE_LIMIT_MAX_MESSAGE_LENGTH}. */
	message: string;
}

/**
 * One active throttle on a node, as stored on the node row and shown in the
 * Fleet node list / drawer.
 */
export interface FleetNodeModelThrottleView {
	provider: string;
	window: FleetModelUsageLimitWindow;
	/** When the platform will offer this node that CLI's work again (ISO). */
	until: string;
	/** The CLI's sentence that started this window. */
	reason: string;
	/** When this window was first recorded (ISO). */
	since: string;
}

export interface DetectFleetModelUsageLimitOptions {
	/** The CLI whose output this is. Defaults to `claude-code`. */
	provider?: string;
	/** "Now", for resolving a wall-clock reset ("3am") and for the clamp. */
	now?: Date | number;
	/**
	 * IANA zone a reset time with no zone of its own is read in. The node
	 * passes its OWN zone — the CLI printed the machine's local time. The API
	 * (reading an older node's sentence) has no better answer than UTC.
	 */
	timeZone?: string;
	/**
	 * Only the unambiguous phrases. Used for a CLI's raw output tail, which
	 * can contain the MODEL's own words: a Task about rate limiting must
	 * never read as the CLI being rate limited.
	 */
	strict?: boolean;
}

interface LimitSignature {
	pattern: RegExp;
	/** Recognised in `strict` mode too. */
	strict: boolean;
}

/**
 * The CLIs' own words. Order matters only for the reported window, which is
 * read separately below.
 *
 * Claude Code: `You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)`,
 * `5-hour limit reached ∙ resets 3pm`, `Claude usage limit reached. Your limit
 * will reset at 3pm (Europe/Paris).`, the older `Claude AI usage limit
 * reached|1760000000`, and the API's `429 {"type":"error","error":{"type":
 * "rate_limit_error",…}}`.
 *
 * Codex: `You've hit your usage limit. … try again in 2 days 3 hours`,
 * `stream error: exceeded retry limit, last status: 429 Too Many Requests`,
 * `usage_limit_reached`.
 */
const LIMIT_SIGNATURES: readonly LimitSignature[] = [
	{ pattern: /\bhit (?:your|the) (?:[\w-]+ )?(?:usage |rate )?limit\b/i, strict: true },
	{
		pattern:
			/\b(?:usage|weekly|daily|session|5[- ]hour|five[- ]hour) limit (?:has been )?(?:reached|exceeded|hit)\b/i,
		strict: true
	},
	{ pattern: /\busage[_ ]limit[_ ](?:reached|exceeded)\b/i, strict: true },
	{ pattern: /\brate_limit_error\b/, strict: true },
	{ pattern: /\bexceeded retry limit,? last status:? 429\b/i, strict: true },
	{ pattern: /\b429\b[^\n]{0,40}\btoo many requests\b/i, strict: true },
	{ pattern: /\bAPI Error:? 429\b/i, strict: true },
	{ pattern: /\brate[- ]limit(?:ed)?\b[^\n]{0,20}\b(?:reached|exceeded)\b/i, strict: false },
	{ pattern: /\bout of (?:extra )?usage\b/i, strict: false }
];

/**
 * Recognise a model-CLI usage / rate limit in `text`, or null.
 *
 * Deliberately narrow: a false positive here parks real work behind a limit
 * that does not exist, so only the CLIs' own phrases match (see
 * {@link LIMIT_SIGNATURES}), and `strict` narrows them further for raw output.
 */
export function detectFleetModelUsageLimit(
	text: unknown,
	options: DetectFleetModelUsageLimitOptions = {}
): FleetModelUsageLimit | null {
	if (typeof text !== 'string' || !text.trim()) return null;
	const strict = options.strict === true;
	const match = LIMIT_SIGNATURES.find((signature) => (!strict || signature.strict) && signature.pattern.test(text));
	if (!match) return null;
	const nowMs = toEpochMs(options.now);
	const provider =
		typeof options.provider === 'string' && options.provider.trim() ? options.provider.trim() : 'claude-code';
	const resetsAtMs = parseResetInstant(text, nowMs, options.timeZone);
	const resetsAt = resetsAtMs !== null && resetsAtMs > nowMs ? resetsAtMs : null;
	return {
		provider,
		window: classifyWindow(text),
		resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
		retryAfter: new Date(
			clampRetryAfterMs(
				resetsAt === null
					? nowMs + FLEET_MODEL_USAGE_LIMIT_FALLBACK_MS
					: resetsAt + FLEET_MODEL_USAGE_LIMIT_RESET_SLACK_MS,
				nowMs
			)
		).toISOString(),
		message: describeLimitSentence(text, match.pattern)
	};
}

/**
 * Clamp a retry instant into `[now + MIN, now + MAX]`. The API applies it to a
 * NODE-supplied `retryAfter` too: the node's clock is not the platform's, and
 * a node must not be able to park work for a year.
 */
export function clampRetryAfterMs(retryAfterMs: number, nowMs: number): number {
	const floor = nowMs + FLEET_MODEL_USAGE_LIMIT_MIN_MS;
	const ceiling = nowMs + FLEET_MODEL_USAGE_LIMIT_MAX_MS;
	if (!Number.isFinite(retryAfterMs)) return nowMs + FLEET_MODEL_USAGE_LIMIT_FALLBACK_MS;
	return Math.min(Math.max(retryAfterMs, floor), ceiling);
}

const WINDOWS: readonly FleetModelUsageLimitWindow[] = ['weekly', 'session', 'daily', 'rate', 'usage'];

/**
 * Read the usage limit an `agent-task` job result reports, or null.
 *
 * Two shapes, in order:
 *  1. a current node's explicit `failureKind: 'model_usage_limit'` with its
 *     `modelUsageLimit` block — trusted for the CLI and the window, but its
 *     `retryAfter` is re-clamped against THIS clock;
 *  2. an OLDER node's plain failed result whose model step failed with one of
 *     the CLI sentences in `model.summary` (the CLI's own final message —
 *     never the output tail, which can carry the model's words).
 *
 * Anything else — a succeeded run, a red gate, a git failure — is null.
 */
export function readFleetJobModelUsageLimit(
	result: unknown,
	options: { now?: Date | number; timeZone?: string } = {}
): FleetModelUsageLimit | null {
	if (!result || typeof result !== 'object') return null;
	const record = result as Record<string, unknown>;
	const nowMs = toEpochMs(options.now);
	if (record.failureKind === FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT) {
		const block = record.modelUsageLimit;
		const limit = block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
		const model = record.model && typeof record.model === 'object' ? (record.model as Record<string, unknown>) : {};
		const provider =
			typeof limit.provider === 'string' && limit.provider.trim()
				? limit.provider.trim().slice(0, 32)
				: typeof model.provider === 'string'
					? model.provider
					: 'claude-code';
		const requested = typeof limit.retryAfter === 'string' ? Date.parse(limit.retryAfter) : Number.NaN;
		const resetsAtMs = typeof limit.resetsAt === 'string' ? Date.parse(limit.resetsAt) : Number.NaN;
		const message =
			typeof limit.message === 'string' && limit.message.trim()
				? trimSentence(limit.message)
				: typeof record.failureReason === 'string'
					? trimSentence(record.failureReason)
					: `${provider} usage limit reached`;
		return {
			provider,
			window: WINDOWS.includes(limit.window as FleetModelUsageLimitWindow)
				? (limit.window as FleetModelUsageLimitWindow)
				: 'usage',
			resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null,
			retryAfter: new Date(
				clampRetryAfterMs(
					Number.isFinite(requested) ? requested : nowMs + FLEET_MODEL_USAGE_LIMIT_FALLBACK_MS,
					nowMs
				)
			).toISOString(),
			message
		};
	}
	if (record.status !== 'failed') return null;
	const model = record.model;
	if (!model || typeof model !== 'object') return null;
	const step = model as Record<string, unknown>;
	if (step.status === 'succeeded') return null;
	// `strict`: only the CLIs' own unambiguous sentences. This path parks work
	// and throttles a node on the strength of text alone, from a node that did
	// not classify it itself, so a generic "rate limit exceeded" in a failed
	// run's final message is not enough.
	return detectFleetModelUsageLimit(step.summary, {
		provider: typeof step.provider === 'string' ? step.provider : undefined,
		now: nowMs,
		strict: true,
		...(options.timeZone ? { timeZone: options.timeZone } : {})
	});
}

/**
 * The throttles on a node row that are still in force at `now`, newest
 * window first per provider. Tolerates anything the JSON column may hold.
 */
export function activeFleetNodeModelThrottles(
	stored: unknown,
	now: Date | number = Date.now()
): FleetNodeModelThrottleView[] {
	if (!Array.isArray(stored)) return [];
	const nowMs = toEpochMs(now);
	const byProvider = new Map<string, FleetNodeModelThrottleView>();
	for (const entry of stored) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
		const untilMs = typeof row.until === 'string' ? Date.parse(row.until) : Number.NaN;
		if (!provider || !Number.isFinite(untilMs) || untilMs <= nowMs) continue;
		const sinceMs = typeof row.since === 'string' ? Date.parse(row.since) : Number.NaN;
		const view: FleetNodeModelThrottleView = {
			provider,
			window: WINDOWS.includes(row.window as FleetModelUsageLimitWindow)
				? (row.window as FleetModelUsageLimitWindow)
				: 'usage',
			until: new Date(untilMs).toISOString(),
			reason: typeof row.reason === 'string' ? trimSentence(row.reason) : `${provider} usage limit reached`,
			since: new Date(Number.isFinite(sinceMs) ? sinceMs : nowMs).toISOString()
		};
		const previous = byProvider.get(provider);
		if (!previous || Date.parse(previous.until) < untilMs) byProvider.set(provider, view);
	}
	return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Human label for a CLI provider token (`claude-code` → `Claude Code`). */
export function describeFleetModelProvider(provider: string): string {
	switch (provider) {
		case 'claude-code':
			return 'Claude Code';
		case 'codex':
			return 'Codex';
		default:
			return provider;
	}
}

/** Human label for a window (`weekly` → `weekly limit`). */
export function describeFleetModelUsageLimitWindow(window: FleetModelUsageLimitWindow): string {
	switch (window) {
		case 'weekly':
			return 'weekly limit';
		case 'session':
			return '5-hour limit';
		case 'daily':
			return 'daily limit';
		case 'rate':
			return 'rate limit';
		default:
			return 'usage limit';
	}
}

// ─── internals ──────────────────────────────────────────────────────────

function toEpochMs(value: Date | number | undefined): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	return Date.now();
}

function classifyWindow(text: string): FleetModelUsageLimitWindow {
	if (/\bweekly\b|\bper week\b/i.test(text)) return 'weekly';
	if (/\b(?:5|five)[- ]hour\b|\bsession limit\b/i.test(text)) return 'session';
	if (/\bdaily\b|\bper day\b/i.test(text)) return 'daily';
	if (/\b429\b|rate_limit_error|\brate[- ]limit/i.test(text)) return 'rate';
	return 'usage';
}

function trimSentence(text: string): string {
	// eslint-disable-next-line no-control-regex
	const clean = text
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const points = Array.from(clean);
	return points.length > FLEET_MODEL_USAGE_LIMIT_MAX_MESSAGE_LENGTH
		? `${points
				.slice(0, FLEET_MODEL_USAGE_LIMIT_MAX_MESSAGE_LENGTH - 1)
				.join('')
				.trimEnd()}…`
		: clean;
}

/** The line that matched (the CLI's sentence), not the whole output. */
function describeLimitSentence(text: string, pattern: RegExp): string {
	const line = text.split(/\r?\n/).find((candidate) => pattern.test(candidate));
	return trimSentence(line ?? text);
}

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	sept: 8,
	oct: 9,
	nov: 10,
	dec: 11
};

/**
 * The reset instant the text names, as epoch ms, or null.
 *
 * Understood, in this order: an epoch after `usage limit reached|` (older
 * Claude Code), an ISO instant, a relative "in 2 days 3 hours" / "in 4h 12m",
 * and a wall-clock "resets Oct 19, 3am (Europe/Paris)" / "reset at 3:30pm" /
 * "try again at 15:00" read in the stated zone, else `timeZone`, else UTC.
 */
function parseResetInstant(text: string, nowMs: number, timeZone: string | undefined): number | null {
	const epoch = /usage limit reached\|(\d{10,13})\b/i.exec(text);
	if (epoch) {
		const value = Number(epoch[1]);
		return epoch[1].length >= 13 ? value : value * 1000;
	}

	const iso =
		/\b(?:resets?|reset at|try again at|available again at|until)\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(
			text
		);
	if (iso) {
		const value = Date.parse(iso[1]);
		if (Number.isFinite(value)) return value;
	}

	const relative =
		/\b(?:resets?|reset|try again|available again|retry)\s+in\s+((?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b(?:[\s,]+(?:and )?)?)+)/i.exec(
			text
		);
	if (relative) {
		const ms = parseDuration(relative[1]);
		if (ms > 0) return nowMs + ms;
	}

	const wall =
		/\b(?:resets?|reset at|will reset at|try again at|available again at)\s+(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}|UTC|GMT)\))?/i.exec(
			text
		);
	if (wall) {
		const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = wall;
		let hour = Number(hourText);
		const minute = minuteText ? Number(minuteText) : 0;
		if (!meridiem && !minuteText && !monthName) {
			// A bare number ("resets 3") is not a time anyone prints.
			return null;
		}
		if (meridiem) {
			if (hour < 1 || hour > 12) return null;
			hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
		}
		if (hour > 23 || minute > 59) return null;
		const zone = resolveZone(zoneText) ?? resolveZone(timeZone) ?? 'UTC';
		const today = zonedParts(nowMs, zone);
		if (monthName) {
			const month = MONTHS[monthName.toLowerCase()];
			const day = Number(dayText);
			if (month === undefined || day < 1 || day > 31) return null;
			let candidate = zonedWallTimeToUtc(today.year, month, day, hour, minute, zone);
			// "Oct 19" in late December means next year's October.
			if (candidate < nowMs - 24 * 60 * 60 * 1000) {
				candidate = zonedWallTimeToUtc(today.year + 1, month, day, hour, minute, zone);
			}
			return candidate;
		}
		let candidate = zonedWallTimeToUtc(today.year, today.month, today.day, hour, minute, zone);
		if (candidate <= nowMs) {
			candidate = zonedWallTimeToUtc(today.year, today.month, today.day + 1, hour, minute, zone);
		}
		return candidate;
	}
	return null;
}

function parseDuration(text: string): number {
	// A hand-rolled scan rather than a global regex: `(\d+)\s*unit` re-tried
	// from every position is polynomial on a long run of digits (CodeQL), and
	// this reads untrusted CLI output.
	let total = 0;
	let index = 0;
	const length = Math.min(text.length, 200);
	while (index < length) {
		if (!isDigit(text.charCodeAt(index))) {
			index += 1;
			continue;
		}
		let value = 0;
		while (index < length && isDigit(text.charCodeAt(index))) {
			value = Math.min(value * 10 + (text.charCodeAt(index) - 48), 1_000_000);
			index += 1;
		}
		while (index < length && text[index] === ' ') index += 1;
		let word = '';
		while (index < length && /[a-z]/i.test(text[index]!)) {
			word += text[index]!.toLowerCase();
			index += 1;
		}
		const unitMs = DURATION_UNITS[word];
		if (unitMs !== undefined) total += value * unitMs;
	}
	return total;
}

const DURATION_UNITS: Record<string, number> = {
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	s: 1000,
	sec: 1000,
	secs: 1000,
	second: 1000,
	seconds: 1000
};

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}

function resolveZone(zone: string | undefined): string | null {
	if (typeof zone !== 'string' || !zone.trim()) return null;
	const candidate = zone.trim();
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: candidate });
		return candidate;
	} catch {
		return null;
	}
}

interface ZonedParts {
	year: number;
	/** 0-based. */
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function zonedParts(instantMs: number, zone: string): ZonedParts {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(new Date(instantMs));
	const get = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(parts.find((part) => part.type === type)?.value ?? 0);
	return {
		year: get('year'),
		month: get('month') - 1,
		day: get('day'),
		hour: get('hour') % 24,
		minute: get('minute'),
		second: get('second')
	};
}

/** Offset of `zone` from UTC at `instantMs`, in ms (Paris in summer → +7_200_000). */
function zoneOffsetMs(instantMs: number, zone: string): number {
	const whole = Math.floor(instantMs / 1000) * 1000;
	const p = zonedParts(whole, zone);
	return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - whole;
}

/** The UTC instant at which the wall clock in `zone` reads the given time. */
function zonedWallTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	zone: string
): number {
	const asIfUtc = Date.UTC(year, month, day, hour, minute, 0);
	const firstOffset = zoneOffsetMs(asIfUtc, zone);
	const guess = asIfUtc - firstOffset;
	const secondOffset = zoneOffsetMs(guess, zone);
	return secondOffset === firstOffset ? guess : asIfUtc - secondOffset;
}
