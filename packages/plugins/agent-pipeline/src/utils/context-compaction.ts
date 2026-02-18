import { estimateTokenCount } from 'tokenx';
import type { ModelMessage } from 'ai';
import type { PluginLogger } from '@ever-works/plugin';

const RECENT_PAIRS_TO_KEEP = 10;

export interface ContextCompactionOptions {
	maxContextTokens: number;
	budgetRatio?: number;
	maxSingleOutputChars?: number;
	logger?: PluginLogger;
}

// --- Internal types matching Vercel AI SDK v6 message part structures ---

interface ToolCallPart {
	type: 'tool-call';
	toolCallId: string;
	toolName: string;
	input: unknown;
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

function getOutputString(output: ToolResultPart['output']): string {
	if (!output) return '';
	if (output.type === 'text') return String(output.value ?? '');
	if (output.type === 'json') return JSON.stringify(output.value);
	return '';
}

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

function fileOpSummary(verb: string, args: Record<string, unknown>, value: unknown): string {
	const path = args?.path ?? 'unknown';
	if (typeof value === 'object' && value !== null) {
		const obj = value as Record<string, unknown>;
		return obj.success ? `${verb}: ${obj.path ?? path}` : `${verb} failed: ${obj.error ?? path}`;
	}
	return `${verb}: ${path}`;
}

type Summarizer = (args: Record<string, unknown>, value: unknown) => string;

const TOOL_SUMMARIZERS: Record<string, Summarizer> = {
	search: (args, value) =>
		`Searched '${args.query ?? 'unknown'}' -> ${Array.isArray(value) ? value.length : '?'} results`,
	bash: (args) => `Ran: ${args.command ?? 'unknown'}`,
	readFile: (args) => `Read: ${args.path ?? args.filePath ?? 'unknown'}`,
	createFile: (args, value) => fileOpSummary('Created', args, value),
	updateFile: (args, value) => fileOpSummary('Updated', args, value),
	validateItemJson: (args, value) => {
		const path = args?.path ?? 'unknown';
		if (typeof value === 'object' && value !== null) {
			const obj = value as Record<string, unknown>;
			return obj.valid ? `${path}: valid` : `${path}: ${obj.error ?? 'invalid'}`;
		}
		return `${path}: validated`;
	},
	processUrls: (_args, value) => {
		if (Array.isArray(value)) {
			const totalItems = value.reduce((sum: number, r: { count?: number }) => sum + (r?.count ?? 0), 0);
			return `Processed ${value.length} URLs -> ${totalItems} items`;
		}
		return 'Processed URLs';
	},
	modifyItems: (_args, value) => {
		if (typeof value === 'object' && value !== null) {
			const obj = value as Record<string, unknown>;
			return `Modified ${obj.count ?? '?'} files`;
		}
		return 'Modified items';
	},
	getWorkspaceOverview: (_args, value) => {
		if (typeof value === 'object' && value !== null) {
			const obj = value as Record<string, unknown>;
			const cats = Array.isArray(obj.categories) ? obj.categories.length : '?';
			return `Workspace: ${obj.totalItems ?? '?'} items, ${cats} categories`;
		}
		return 'Workspace overview';
	}
};

function compactResultPart(part: ToolResultPart, args?: Record<string, unknown>): ToolResultPart {
	const summarizer = TOOL_SUMMARIZERS[part.toolName];
	let summary: string;

	if (summarizer) {
		const value = getOutputValue(part.output);
		summary = summarizer(args ?? {}, value);
	} else {
		const raw = getOutputString(part.output);
		summary = raw.length > 200 ? raw.slice(0, 200) + '\u2026' : raw;
	}

	return { ...part, output: { type: 'text', value: summary } };
}

function findRecentBoundary(messages: ModelMessage[], pairsToKeep: number): number {
	if (pairsToKeep <= 0) return messages.length;
	let toolMsgCount = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as { role: string }).role === 'tool') {
			toolMsgCount++;
			if (toolMsgCount >= pairsToKeep) {
				return i;
			}
		}
	}
	return 0;
}

function buildArgsMap(messages: ModelMessage[]): Map<string, Record<string, unknown>> {
	const argsMap = new Map<string, Record<string, unknown>>();
	for (const msg of messages) {
		const m = msg as { role: string; content: unknown };
		if (m.role === 'assistant' && Array.isArray(m.content)) {
			for (const part of m.content) {
				if ((part as ToolCallPart).type === 'tool-call') {
					const tc = part as ToolCallPart;
					argsMap.set(tc.toolCallId, tc.input as Record<string, unknown>);
				}
			}
		}
	}
	return argsMap;
}

function compactOlderResults(
	messages: ModelMessage[],
	recentBoundary: number,
	argsMap: Map<string, Record<string, unknown>>
): ModelMessage[] {
	return messages.map((msg, idx) => {
		const m = msg as { role: string; content: unknown };
		if (idx >= recentBoundary || m.role !== 'tool') return msg;

		const content = m.content;
		if (!Array.isArray(content)) return msg;

		const compacted = content.map((part: unknown) => {
			const p = part as ToolResultPart;
			if (p.type !== 'tool-result') return part;
			const args = argsMap.get(p.toolCallId);
			return compactResultPart(p, args);
		});

		return { ...msg, content: compacted } as ModelMessage;
	});
}

function truncateOversizedOutputs(
	messages: ModelMessage[],
	maxChars: number
): { messages: ModelMessage[]; changed: boolean } {
	let changed = false;

	const result = messages.map((msg) => {
		const m = msg as { role: string; content: unknown };
		if (m.role !== 'tool' || !Array.isArray(m.content)) return msg;

		let msgChanged = false;
		const newContent = m.content.map((part: unknown) => {
			const p = part as ToolResultPart;
			if (p.type !== 'tool-result') return part;

			const outputStr = getOutputString(p.output);
			if (outputStr.length <= maxChars) return part;

			msgChanged = true;
			const truncated = outputStr.slice(0, maxChars) + `\n\n[Output truncated: ${outputStr.length} chars total]`;
			return { ...p, output: { type: 'text', value: truncated } };
		});

		if (msgChanged) {
			changed = true;
			return { ...msg, content: newContent } as ModelMessage;
		}
		return msg;
	});

	return { messages: result, changed };
}

function dropOldestPairs(
	messages: ModelMessage[],
	boundary: number,
	budget: number,
	logger?: PluginLogger
): ModelMessage[] {
	if (boundary <= 1) return messages;

	const keepFirst = messages.slice(0, 1);
	const droppable = messages.slice(1, boundary);
	const recent = messages.slice(boundary);

	const costs = droppable.map((m) => estimateTokenCount(JSON.stringify(m)));
	let droppableTotal = costs.reduce((a, b) => a + b, 0);
	const fixedTotal = estimateMessages([...keepFirst, ...recent]);

	let dropCount = 0;
	while (dropCount < droppable.length && fixedTotal + droppableTotal > budget) {
		droppableTotal -= costs[dropCount];
		dropCount++;
	}

	// Round up to even to preserve assistant+tool pairing
	if (dropCount % 2 !== 0 && dropCount < droppable.length) {
		droppableTotal -= costs[dropCount];
		dropCount++;
	}

	if (dropCount > 0) {
		logger?.log(
			`Dropped ${dropCount} oldest compacted messages (~${Math.floor(dropCount / 2)} pairs) to fit budget`
		);
	}

	return [...keepFirst, ...droppable.slice(dropCount), ...recent];
}

export function createPrepareStep(options: ContextCompactionOptions) {
	const { maxContextTokens, budgetRatio = 0.7, maxSingleOutputChars, logger } = options;
	const budget = Math.floor(maxContextTokens * budgetRatio);

	return ({ messages }: { messages: ModelMessage[] }): { messages: ModelMessage[] } | undefined => {
		// Layer 1: Truncate any oversized individual outputs (safety net)
		let current = messages;
		let changed = false;
		if (maxSingleOutputChars) {
			const result = truncateOversizedOutputs(messages, maxSingleOutputChars);
			current = result.messages;
			changed = result.changed;
		}

		// Layer 2: Check budget
		const tokens = estimateMessages(current);
		if (tokens <= budget) {
			return changed ? { messages: current } : undefined;
		}

		// Layer 3: Progressive compaction — each pass operates on the same base
		logger?.log(`Context compaction triggered: ~${tokens} tokens exceeds budget of ${budget}`);
		const argsMap = buildArgsMap(current);
		let bestResult = current;

		for (const pairsToKeep of [RECENT_PAIRS_TO_KEEP, 5, 2, 1]) {
			const boundary = findRecentBoundary(current, pairsToKeep);
			const compacted = compactOlderResults(current, boundary, argsMap);
			bestResult = compacted;
			const reduced = estimateMessages(compacted);
			if (reduced <= budget) {
				logger?.log(`Compaction fit at window=${pairsToKeep}: ~${reduced} tokens`);
				return { messages: compacted };
			}
		}

		// Layer 4: Drop oldest compacted pairs until under budget
		// findRecentBoundary returns the index of the last tool message.
		// Walk back to include its preceding assistant message in the protected recent window.
		const rawBoundary = findRecentBoundary(bestResult, 1);
		const evictBoundary =
			rawBoundary > 1 && (bestResult[rawBoundary - 1] as { role: string }).role === 'assistant'
				? rawBoundary - 1
				: rawBoundary;

		bestResult = dropOldestPairs(bestResult, evictBoundary, budget, logger);

		const finalTokens = estimateMessages(bestResult);
		if (finalTokens <= budget) {
			logger?.log(`Fit after eviction: ~${finalTokens} tokens`);
		} else {
			logger?.warn(`Context still over budget after eviction: ~${finalTokens} tokens (budget: ${budget})`);
		}

		return { messages: bestResult };
	};
}
