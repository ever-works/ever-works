import {
	USAGE_UNKNOWN_MODEL,
	parseUsageJson,
	usageCount,
	usageCwd,
	usageModel,
	usageObject,
	usageSessionId,
	usageTime,
	type UsageRecord
} from './usage-record';

/**
 * Usage & cost on the fleet (FL-20, plan §3 "Codex records", T-09) — read the
 * lines of a Codex rollout (`<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`)
 * in order, keeping only what the scan may keep.
 *
 * Unlike a Claude Code line, a Codex line is not self-contained: the session
 * id and folder come from the file's `session_meta` line, the model from the
 * newest `turn_context`, and the tokens from `event_msg` / `token_count`
 * events. So the parser carries a small per-file state ({@link CodexFileState},
 * persisted with the file's offset so a scan resumes mid-file).
 *
 *  - tokens: the event's `last_token_usage` (one request) — `input_tokens`
 *    INCLUDES `cached_input_tokens` on this provider, so uncached input is the
 *    difference; output is `output_tokens`; the provider bills no cache write.
 *    An older event without `last_token_usage` counts the growth of
 *    `total_token_usage` since the previous event in the file;
 *  - identity (FR-4): the session id plus the cumulative totals at that event —
 *    a re-emitted event (the CLI repeats `token_count` when only its rate-limit
 *    snapshot changed) or a replayed one in a resumed rollout is counted once.
 *
 * Instructions, messages, reasoning, tool calls and their output are never
 * copied out of the parsed object.
 */

export interface CodexTotals {
	input: number;
	cached: number;
	output: number;
	total: number;
}

/** What the parser remembers between lines of one rollout file. */
export interface CodexFileState {
	sessionId: string | null;
	model: string | null;
	cwd: string | null;
	prev: CodexTotals | null;
}

export function emptyCodexFileState(): CodexFileState {
	return { sessionId: null, model: null, cwd: null, prev: null };
}

/** Cheap pre-filter: lines that can change the state or carry usage. */
export function mayBeCodexUsageLine(line: string): boolean {
	return (
		line.includes('token_count') ||
		line.includes('session_meta') ||
		line.includes('turn_context') ||
		// The pre-`session_meta` first line: `{"id": …, "timestamp": …, "instructions": …}`.
		(line.startsWith('{"id"') && line.includes('"timestamp"'))
	);
}

function totals(value: unknown): CodexTotals | null {
	const usage = usageObject(value);
	if (!usage) return null;
	const input = usageCount(usage.input_tokens);
	const cached = usageCount(usage.cached_input_tokens);
	const output = usageCount(usage.output_tokens);
	const total = usageCount(usage.total_tokens) || input + output;
	return { input, cached, output, total };
}

/** Read one line, updating `state`; answers a record when the line is a usage event. */
export function parseCodexUsageLine(line: string, state: CodexFileState): UsageRecord | null {
	if (!mayBeCodexUsageLine(line)) return null;
	const record = parseUsageJson(line);
	if (!record) return null;
	const payload = usageObject(record.payload);
	if (record.type === 'session_meta' && payload) {
		state.sessionId = usageSessionId(payload.id) ?? state.sessionId;
		state.cwd = usageCwd(payload.cwd) ?? state.cwd;
		if (typeof payload.model === 'string') state.model = usageModel(payload.model);
		return null;
	}
	if (record.type === 'turn_context' && payload) {
		if (typeof payload.model === 'string') state.model = usageModel(payload.model);
		state.cwd = usageCwd(payload.cwd) ?? state.cwd;
		return null;
	}
	if (record.type === undefined && typeof record.id === 'string') {
		// The older rollout header line.
		state.sessionId = usageSessionId(record.id) ?? state.sessionId;
		return null;
	}
	if (record.type !== 'event_msg' || !payload || payload.type !== 'token_count') return null;
	const info = usageObject(payload.info);
	if (!info) return null;
	const at = usageTime(record.timestamp);
	if (at === null) return null;
	const total = totals(info.total_token_usage);
	const last = totals(info.last_token_usage);
	let request: CodexTotals | null = last;
	if (!request && total) {
		const prev = state.prev;
		request = prev
			? {
					input: Math.max(0, total.input - prev.input),
					cached: Math.max(0, total.cached - prev.cached),
					output: Math.max(0, total.output - prev.output),
					total: Math.max(0, total.total - prev.total)
				}
			: total;
	}
	if (total) state.prev = total;
	if (!request) return null;
	const tokens = {
		in: Math.max(0, request.input - request.cached),
		out: request.output,
		cacheRead: Math.min(request.cached, request.input || request.cached),
		cacheWrite: 0
	};
	if (tokens.in + tokens.out + tokens.cacheRead === 0) return null;
	const point = total ? `${total.total}:${total.input}:${total.output}` : `t${at}`;
	return {
		provider: 'codex',
		key: `codex:${state.sessionId ?? 'nosession'}:${point}`,
		sessionId: state.sessionId,
		model: state.model ?? USAGE_UNKNOWN_MODEL,
		at,
		cwd: state.cwd,
		tokens
	};
}
