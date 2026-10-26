import { parseUsageJson, usageCount, usageCwd, usageModel, usageObject, usageSessionId, usageTime, type UsageRecord } from './usage-record';

/**
 * Usage & cost on the fleet (FL-20, plan §3 "Claude Code records", T-09) —
 * read ONE line of a Claude Code transcript (`<config home>/projects/<project>/<session>.jsonl`)
 * and keep only what the scan may keep.
 *
 * A usage record is an `assistant` line whose `message` carries `usage`:
 *
 *  - identity (FR-4): the API message id plus the request id — Claude Code
 *    writes one line per content block of a response, every one with the
 *    same ids and usage, and a resumed session copies earlier lines into its
 *    new file; the dedupe keeps one count per identity;
 *  - model: `message.model` (`<synthetic>` placeholders carry no usage and are skipped);
 *  - tokens: `input_tokens` (uncached input), `output_tokens`,
 *    `cache_read_input_tokens`, `cache_creation_input_tokens`;
 *  - session id: the line's `sessionId`; folder: its `cwd`; time: its `timestamp`.
 *
 * Everything else on the line — the message content, tool input, tool
 * output, the prompt — is never copied out of the parsed object.
 */

/** Cheap pre-filter: a line without both markers is not a usage record (never parsed). */
export function mayBeClaudeUsageLine(line: string): boolean {
	return line.includes('"usage"') && line.includes('"assistant"');
}

export function parseClaudeUsageLine(line: string): UsageRecord | null {
	if (!mayBeClaudeUsageLine(line)) return null;
	const record = parseUsageJson(line);
	if (!record || record.type !== 'assistant') return null;
	const message = usageObject(record.message);
	const usage = usageObject(message?.usage);
	if (!message || !usage) return null;
	const rawModel = message.model;
	if (typeof rawModel === 'string' && rawModel.startsWith('<')) return null;
	const at = usageTime(record.timestamp);
	if (at === null) return null;
	const tokens = {
		in: usageCount(usage.input_tokens),
		out: usageCount(usage.output_tokens),
		cacheRead: usageCount(usage.cache_read_input_tokens),
		cacheWrite: usageCount(usage.cache_creation_input_tokens)
	};
	if (tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite === 0) return null;
	const messageId = typeof message.id === 'string' && message.id.length <= 200 ? message.id : null;
	const requestId = typeof record.requestId === 'string' && record.requestId.length <= 200 ? record.requestId : null;
	const uuid = typeof record.uuid === 'string' && record.uuid.length <= 200 ? record.uuid : null;
	// Provider ids only; a line with none of them cannot be counted exactly once.
	const identity = messageId || requestId ? `${messageId ?? ''}:${requestId ?? ''}` : uuid;
	if (!identity) return null;
	return {
		provider: 'claude-code',
		key: `claude-code:${identity}`,
		sessionId: usageSessionId(record.sessionId),
		model: usageModel(rawModel),
		at,
		cwd: usageCwd(record.cwd),
		tokens
	};
}
