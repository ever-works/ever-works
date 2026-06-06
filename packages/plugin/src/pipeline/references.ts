export type ReferenceStatus = 'success' | 'empty' | 'error' | 'skipped';

export interface ReferenceEntry {
	readonly url: string;
	readonly normalized_url: string;
	readonly first_seen_at?: string;
	readonly last_attempted_at: string;
	readonly last_success_at?: string;
	readonly status: ReferenceStatus;
	readonly items_created?: number;
	readonly pipeline?: string;
	readonly provider?: string;
	readonly error?: string;
}

export interface ReferencePolicy {
	readonly ttlDays: number;
	readonly now?: Date;
}

export interface ReferenceSkipDecision {
	readonly shouldSkip: boolean;
	readonly reference?: ReferenceEntry;
	readonly reason?: string;
}

const DEFAULT_REFERENCE_TTL_DAYS = 90;
const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_NAMES = new Set(['fbclid', 'gclid', 'msclkid', 'srsltid']);

export function getDefaultReferenceTtlDays(): number {
	return DEFAULT_REFERENCE_TTL_DAYS;
}

// Security: ReferenceEntry.error is populated from error messages that
// originate from fetching hostile, attacker-controlled URLs (a malicious
// server can shape the message via its response). Strip control characters
// (newlines, tabs, ANSI/ESC, other C0/C1 codes) to prevent log injection when
// entries are serialized into structured logs, and cap the length so a crafted
// error body can't bloat persisted entries / API responses. The class covers
// C0 (0x00-0x1F), DEL + C1 (0x7F-0x9F) and leaves all printable text
// (including accented Latin at 0xC0 and above) untouched.
const MAX_REFERENCE_ERROR_LENGTH = 512;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x1F\x7F-\x9F]/g;

function sanitizeReferenceError(error: string): string {
	const cleaned = error.replace(CONTROL_CHARS_PATTERN, ' ');
	return cleaned.length > MAX_REFERENCE_ERROR_LENGTH ? cleaned.slice(0, MAX_REFERENCE_ERROR_LENGTH) : cleaned;
}

export function normalizeReferenceUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return trimmed;
	}

	try {
		const parsed = new URL(trimmed);
		// Security: only http(s) references may be normalized + stored. `new URL`
		// happily parses javascript:, data:, file:, blob: etc., which would then
		// land in ReferenceEntry.normalized_url and could reach a frontend that
		// renders source_url as <a href> (stored XSS) or a server-side fetcher
		// (SSRF). Reject any non-HTTP(S) scheme by returning an empty string so
		// the entry never matches and is never rendered as a live link.
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return '';
		}
		const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
		const searchParams = [...parsed.searchParams.entries()]
			.filter(([key]) => {
				const normalizedKey = key.toLowerCase();
				return (
					!TRACKING_PARAM_NAMES.has(normalizedKey) &&
					!TRACKING_PARAM_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))
				);
			})
			.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
				if (leftKey === rightKey) {
					return leftValue.localeCompare(rightValue);
				}
				return leftKey.localeCompare(rightKey);
			});
		const search = new URLSearchParams(searchParams).toString();

		return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}${search ? `?${search}` : ''}`;
	} catch {
		return trimmed.toLowerCase().replace(/\/+$/, '');
	}
}

export function getReferenceLastAttemptDate(reference: ReferenceEntry): Date | null {
	const timestamp = reference.last_attempted_at || reference.last_success_at || reference.first_seen_at;
	if (!timestamp) {
		return null;
	}

	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function isReferenceFresh(reference: ReferenceEntry, policy: ReferencePolicy): boolean {
	const lastAttempt = getReferenceLastAttemptDate(reference);
	if (!lastAttempt) {
		return false;
	}

	const ttlDays = Number.isFinite(policy.ttlDays) ? policy.ttlDays : DEFAULT_REFERENCE_TTL_DAYS;
	if (ttlDays <= 0) {
		return false;
	}

	const now = policy.now ?? new Date();
	const ageMs = now.getTime() - lastAttempt.getTime();
	return ageMs >= 0 && ageMs < ttlDays * 24 * 60 * 60 * 1000;
}

export function findReferenceForUrl(
	url: string,
	references: readonly ReferenceEntry[] = []
): ReferenceEntry | undefined {
	const normalized = normalizeReferenceUrl(url);
	return references.find(
		(reference) => reference.normalized_url === normalized || normalizeReferenceUrl(reference.url) === normalized
	);
}

export function shouldSkipReferenceUrl(
	url: string,
	references: readonly ReferenceEntry[] = [],
	policy: Partial<ReferencePolicy> = {}
): ReferenceSkipDecision {
	const reference = findReferenceForUrl(url, references);
	if (!reference) {
		return { shouldSkip: false };
	}

	const resolvedPolicy: ReferencePolicy = {
		ttlDays: policy.ttlDays ?? DEFAULT_REFERENCE_TTL_DAYS,
		now: policy.now
	};

	if (!isReferenceFresh(reference, resolvedPolicy)) {
		return { shouldSkip: false, reference };
	}

	return {
		shouldSkip: true,
		reference,
		reason: `URL was processed recently with status "${reference.status}".`
	};
}

export function filterReferenceUrls(
	urls: readonly string[],
	references: readonly ReferenceEntry[] = [],
	policy: Partial<ReferencePolicy> = {}
): { urls: string[]; skipped: ReferenceEntry[] } {
	const filtered: string[] = [];
	const skipped: ReferenceEntry[] = [];

	for (const url of urls) {
		const decision = shouldSkipReferenceUrl(url, references, policy);
		if (decision.shouldSkip && decision.reference) {
			skipped.push(decision.reference);
			continue;
		}
		filtered.push(url);
	}

	return { urls: filtered, skipped };
}

export function createReferenceEntry(options: {
	readonly url: string;
	readonly status: ReferenceStatus;
	readonly itemsCreated?: number;
	readonly pipeline?: string;
	readonly provider?: string;
	readonly error?: string;
	readonly now?: Date;
	readonly previous?: ReferenceEntry;
}): ReferenceEntry {
	const nowIso = (options.now ?? new Date()).toISOString();
	const normalizedUrl = normalizeReferenceUrl(options.url);
	const success = options.status === 'success';

	return {
		url: options.url,
		normalized_url: normalizedUrl,
		first_seen_at: options.previous?.first_seen_at ?? nowIso,
		last_attempted_at: nowIso,
		last_success_at: success ? nowIso : options.previous?.last_success_at,
		status: options.status,
		items_created: options.itemsCreated,
		pipeline: options.pipeline,
		provider: options.provider,
		// Security: sanitize the attacker-influenced error string (control-char
		// strip + length cap) before it is persisted into the reference entry.
		error: options.error !== undefined ? sanitizeReferenceError(options.error) : undefined
	};
}

export function mergeReferences(
	existing: readonly ReferenceEntry[] = [],
	incoming: readonly ReferenceEntry[] = []
): ReferenceEntry[] {
	const merged = new Map<string, ReferenceEntry>();

	for (const reference of existing) {
		const normalized = reference.normalized_url || normalizeReferenceUrl(reference.url);
		merged.set(normalized, { ...reference, normalized_url: normalized });
	}

	for (const reference of incoming) {
		const normalized = reference.normalized_url || normalizeReferenceUrl(reference.url);
		const previous = merged.get(normalized);
		merged.set(normalized, {
			...reference,
			normalized_url: normalized,
			first_seen_at: reference.first_seen_at ?? previous?.first_seen_at
		});
	}

	return [...merged.values()].sort((left, right) => left.normalized_url.localeCompare(right.normalized_url));
}
