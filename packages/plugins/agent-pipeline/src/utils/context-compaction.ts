import { estimateTokenCount } from 'tokenx';
import type { ModelMessage } from 'ai';
import type { PluginLogger } from '@ever-works/plugin';

/** Tools whose results must never be compacted (already tiny, agent needs to see success/path) */
const FILE_TOOLS = new Set(['createFile', 'updateFile']);

/** Number of recent assistant/tool pairs to protect from compaction */
const RECENT_PAIRS_TO_KEEP = 10;

export interface ContextCompactionOptions {
	maxContextTokens: number;
	budgetRatio?: number;
	logger?: PluginLogger;
}

// --- Internal types matching Vercel AI SDK v6 message part structures ---

interface ToolCallPart {
	type: 'tool-call';
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface ToolResultPart {
	type: 'tool-result';
	toolCallId: string;
	toolName: string;
	output: { type: string; value?: unknown; reason?: string };
}

// --- Helpers ---

function estimateMessages(messages: ModelMessage[]): number {
	return estimateTokenCount(JSON.stringify(messages));
}

/** Extract the string representation of a tool result output */
function getOutputString(output: ToolResultPart['output']): string {
	if (!output) return '';
	if (output.type === 'text') return String(output.value ?? '');
	if (output.type === 'json') return JSON.stringify(output.value);
	return '';
}

/** Extract the structured value from a tool result output */
function getOutputValue(output: ToolResultPart['output']): unknown {
	if (!output) return undefined;
	if (output.type === 'text') {
		try {
			return JSON.parse(String(output.value));
		} catch {
			return output.value;
		}
	}
	if (output.type === 'json') return output.value;
	return undefined;
}

/**
 * Produce a compact summary for a single tool result.
 * Uses tool call arguments for identifying info (query, url, path, command).
 */
function compactResultPart(part: ToolResultPart, args?: Record<string, unknown>): ToolResultPart {
	let summary: string;

	switch (part.toolName) {
		case 'search': {
			const query = args?.query ?? 'unknown';
			const value = getOutputValue(part.output);
			const count = Array.isArray(value) ? value.length : '?';
			summary = `Searched '${query}' -> ${count} results`;
			break;
		}
		case 'extractContent': {
			const value = getOutputValue(part.output);
			const url =
				typeof value === 'object' && value !== null && 'url' in value
					? (value as Record<string, unknown>).url
					: (args?.url ?? 'unknown');
			summary = `Extracted content from ${url}`;
			break;
		}
		case 'bash': {
			const command = args?.command ?? 'unknown';
			summary = `Ran: ${command}`;
			break;
		}
		case 'readFile': {
			const path = args?.path ?? args?.filePath ?? 'unknown';
			summary = `Read: ${path}`;
			break;
		}
		case 'validateItemJson': {
			const path = args?.path ?? 'unknown';
			const value = getOutputValue(part.output);
			if (typeof value === 'object' && value !== null) {
				const obj = value as Record<string, unknown>;
				summary = obj.valid ? `${path}: valid` : `${path}: ${obj.error ?? 'invalid'}`;
			} else {
				summary = `${path}: validated`;
			}
			break;
		}
		default: {
			const raw = getOutputString(part.output);
			summary = raw.length > 200 ? raw.slice(0, 200) + '\u2026' : raw;
			break;
		}
	}

	return { ...part, output: { type: 'text', value: summary } };
}

/**
 * Find the message index that marks the boundary of the recent window.
 * Messages at or after this index are "recent" and won't be compacted.
 */
function findRecentBoundary(messages: ModelMessage[]): number {
	let toolMsgCount = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as { role: string }).role === 'tool') {
			toolMsgCount++;
			if (toolMsgCount >= RECENT_PAIRS_TO_KEEP) {
				return i;
			}
		}
	}
	return 0;
}

/**
 * Walk messages and compact tool result outputs older than recentBoundary.
 * Keeps all assistant messages (tool calls) intact.
 */
function compactOlderResults(messages: ModelMessage[], recentBoundary: number): ModelMessage[] {
	// Build a map of toolCallId -> args from assistant messages in the compaction zone
	const argsMap = new Map<string, Record<string, unknown>>();
	for (let i = 0; i < recentBoundary; i++) {
		const msg = messages[i] as { role: string; content: unknown };
		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if ((part as ToolCallPart).type === 'tool-call') {
					const tc = part as ToolCallPart;
					argsMap.set(tc.toolCallId, tc.args as Record<string, unknown>);
				}
			}
		}
	}

	return messages.map((msg, idx) => {
		const m = msg as { role: string; content: unknown };
		if (idx >= recentBoundary || m.role !== 'tool') return msg;

		const content = m.content;
		if (!Array.isArray(content)) return msg;

		const compacted = content.map((part: unknown) => {
			const p = part as ToolResultPart;
			if (p.type !== 'tool-result') return part;
			if (FILE_TOOLS.has(p.toolName) || p.toolName === 'reportProgress') return part;
			const args = argsMap.get(p.toolCallId);
			return compactResultPart(p, args);
		});

		return { ...msg, content: compacted } as ModelMessage;
	});
}

/**
 * Factory that creates a `prepareStep` callback for context compaction.
 * When the estimated token count exceeds the budget, older tool result outputs
 * are replaced with compact summaries while keeping all assistant messages intact.
 */
export function createPrepareStep(options: ContextCompactionOptions) {
	const { maxContextTokens, budgetRatio = 0.7, logger } = options;
	const budget = Math.floor(maxContextTokens * budgetRatio);

	return ({ messages }: { messages: ModelMessage[] }): { messages: ModelMessage[] } | undefined => {
		const tokens = estimateMessages(messages);
		if (tokens <= budget) return undefined;

		logger?.log(`Context compaction triggered: ~${tokens} tokens exceeds budget of ${budget}`);

		const recentBoundary = findRecentBoundary(messages);
		const compacted = compactOlderResults(messages, recentBoundary);

		return { messages: compacted };
	};
}
