import {
	isFleetUsageModelId,
	isFleetUsageProviderSessionId,
	type FleetUsageProvider,
	type FleetUsageTokens
} from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20, plan §6, spec FR-2, FR-3) — ONE usage
 * record as the scan keeps it: the allow-listed fields of a CLI transcript
 * line and nothing else. Never a prompt, an output, a tool result or a file;
 * the parsers build this from the parsed line and drop the rest on the spot.
 *
 * `cwd` never leaves the machine: the aggregate turns it into a folder bucket
 * (a known checkout or allowed root, else an opaque `other:<hash8>`).
 */
export interface UsageRecord {
	provider: FleetUsageProvider;
	/** The record's identity from the provider's own ids — the dedupe key (FR-4). Never content. */
	key: string;
	/** The CLI's own session id, when it is one we can carry. */
	sessionId: string | null;
	/** The model id as the CLI recorded it (`unknown` when the record named none — tokens only). */
	model: string;
	/** The record's own timestamp (U12: buckets by record time, not scan time). */
	at: number;
	/** The working folder the CLI ran in — LOCAL ONLY (bucketed before anything leaves). */
	cwd: string | null;
	tokens: FleetUsageTokens;
}

/** The model id a record that named none is counted under — tokens only, never priced (FR-8). */
export const USAGE_UNKNOWN_MODEL = 'unknown';

/** Longest working folder kept for bucketing. */
const MAX_CWD_CHARS = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A non-negative integer count, else 0. */
export function usageCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A model id we may carry, else {@link USAGE_UNKNOWN_MODEL}. */
export function usageModel(value: unknown): string {
	return isFleetUsageModelId(value) ? value : USAGE_UNKNOWN_MODEL;
}

/** A provider session id we may carry, else null. */
export function usageSessionId(value: unknown): string | null {
	return isFleetUsageProviderSessionId(value) ? value : null;
}

/** An absolute working folder without control characters, else null. */
export function usageCwd(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CWD_CHARS) return null;
	if (CONTROL_CHARS.test(value)) return null;
	if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value;
	return null;
}

/** A record timestamp (ms), else null. */
export function usageTime(value: unknown): number | null {
	if (typeof value !== 'string' || value.length > 40) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/** Parse one JSON line; null when it is not a JSON object. */
export function parseUsageJson(line: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The object at `value`, else null. */
export function usageObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function totalUsageTokens(tokens: FleetUsageTokens): number {
	return tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite;
}
