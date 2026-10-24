import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	FLEET_SESSION_LINE_MAX_CHARS,
	FLEET_SESSION_PROMPT_MAX_CHARS,
	redactSecrets,
	type FleetSessionAttentionOption,
	type FleetSessionEvidence
} from '@ever-works/contracts';
import type { HookEndpointEvent } from './hook-endpoint';

/**
 * Session status (FL-05, plan §6.3) — what a CLI's hook payload MEANS, as
 * the shared evidence vocabulary (`FleetSessionEvidence`).
 *
 * Every payload is untrusted (a local process holding the token posted it):
 * fields are read by name and type, unknown events are ignored and counted by
 * the caller, nothing is inferred. Every text a card, an Inbox item or a
 * notification may show passes the shared secret scanner here, ON THE NODE,
 * before it leaves the machine (plan §11 d), and is cut to one line.
 *
 * | Claude Code event                      | evidence                                     |
 * | -------------------------------------- | -------------------------------------------- |
 * | `SessionStart`                         | `session-start`                              |
 * | `UserPromptSubmit`                     | `prompt` (+ the "You:" line)                 |
 * | `PermissionRequest`                    | `permission` with the dialog's options       |
 * | `PreToolUse` (`AskUserQuestion`)       | `question` with numbered options + free text |
 * | `PostToolUse`                          | `working` (a terminal answer let it run, U5) |
 * | `Notification` `permission_prompt`     | `permission`, confirm-only (older CLIs)      |
 * | `Notification` `idle_prompt`           | `idle-prompt`                                |
 * | `Stop`                                 | `stop` (+ the agent's last line)             |
 * | `SessionEnd`                           | `session-end`                                |
 * | Codex `agent-turn-complete`            | `prompt` (the turn's input) then `stop`      |
 */

/** One line of a text: the first non-empty line, whitespace collapsed, redacted, bounded. */
export function oneLine(value: unknown, max: number = FLEET_SESSION_LINE_MAX_CHARS): string | undefined {
	if (typeof value !== 'string') return undefined;
	const line = value
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (!line) return undefined;
	const cleaned = redactSecrets(line.replace(/\s+/g, ' ')).cleaned;
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** `Bash(pnpm db:migrate)` — the tool and the one-line gist of what it would do. */
export function describeToolUse(toolName: string, input: unknown): string {
	const record = asRecord(input);
	const pick =
		asString(record?.command) ??
		asString(record?.file_path) ??
		asString(record?.path) ??
		asString(record?.url) ??
		asString(record?.pattern) ??
		asString(record?.description) ??
		(record ? Object.values(record).find((value): value is string => typeof value === 'string') : undefined);
	const gist = oneLine(pick, 120);
	return gist ? `${toolName}(${gist})` : toolName;
}

/** The options of Claude Code's permission dialog, numbered as it numbers them. */
export function claudePermissionOptions(hasSuggestions: boolean): FleetSessionAttentionOption[] {
	return hasSuggestions
		? [
				{ id: '1', label: 'Allow', primary: true },
				{ id: '2', label: "Allow, and don't ask again" },
				{ id: '3', label: 'Deny', deny: true }
			]
		: [
				{ id: '1', label: 'Allow', primary: true },
				{ id: '2', label: 'Deny', deny: true }
			];
}

/** Read the question tool's input (first question; numbered options; "other" always allowed). */
export function claudeQuestion(input: unknown): { prompt?: string; options: FleetSessionAttentionOption[] } {
	const record = asRecord(input);
	const questions = Array.isArray(record?.questions) ? record.questions : [];
	const first = asRecord(questions[0]);
	const prompt = oneLine(first?.question ?? record?.question, FLEET_SESSION_PROMPT_MAX_CHARS);
	const rawOptions = Array.isArray(first?.options) ? first.options : [];
	const options: FleetSessionAttentionOption[] = [];
	for (const raw of rawOptions.slice(0, 8)) {
		const label = oneLine(asRecord(raw)?.label ?? raw, 120);
		if (label) options.push({ id: String(options.length + 1), label, ...(options.length === 0 ? { primary: true } : {}) });
	}
	return { ...(prompt ? { prompt } : {}), options };
}

/**
 * The last thing the assistant said, from the transcript a Claude Code hook
 * names (an older `Stop` payload carries no message). Reads at most the last
 * 64 KiB of a `.jsonl` file inside the person's home folder; anything else,
 * or anything that does not parse, is no line.
 */
export async function readLastAssistantLine(
	transcriptPath: unknown,
	homedir: string,
	readTail: (file: string, bytes: number) => Promise<string> = defaultReadTail
): Promise<string | undefined> {
	if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return undefined;
	const resolved = path.resolve(transcriptPath);
	const relative = path.relative(path.resolve(homedir), resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
	let tail: string;
	try {
		tail = await readTail(resolved, 64 * 1024);
	} catch {
		return undefined;
	}
	const lines = tail.split('\n').reverse();
	for (const line of lines) {
		if (!line.includes('"assistant"')) continue;
		let entry: Record<string, unknown> | null = null;
		try {
			entry = asRecord(JSON.parse(line));
		} catch {
			continue;
		}
		const message = asRecord(entry?.message);
		if (!message || (entry?.type !== 'assistant' && message.role !== 'assistant')) continue;
		const content = message.content;
		if (typeof content === 'string') return oneLine(content);
		if (Array.isArray(content)) {
			for (let index = content.length - 1; index >= 0; index -= 1) {
				const part = asRecord(content[index]);
				if (part?.type === 'text') {
					const text = oneLine(part.text);
					if (text) return text;
				}
			}
		}
	}
	return undefined;
}

async function defaultReadTail(file: string, bytes: number): Promise<string> {
	const handle = await fsp.open(file, 'r');
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		return buffer.toString('utf8');
	} finally {
		await handle.close();
	}
}

export interface HookNormalizeOptions {
	homedir: string;
	readTail?: (file: string, bytes: number) => Promise<string>;
}

/**
 * Turn one hook event into evidence (zero, one or two pieces). Unknown events
 * answer `[]` — the caller counts them, nothing is guessed.
 */
export async function normalizeHookEvent(
	event: HookEndpointEvent,
	options: HookNormalizeOptions
): Promise<FleetSessionEvidence[]> {
	const body = asRecord(event.body);
	if (!body) return [];
	const at = event.at;
	if (event.provider === 'codex') {
		// Codex: `{ type: 'agent-turn-complete', 'input-messages': [...], 'last-assistant-message': … }`.
		if (body.type !== 'agent-turn-complete') return [];
		const inputs = Array.isArray(body['input-messages']) ? body['input-messages'] : [];
		const userLine = oneLine(inputs[inputs.length - 1]);
		const agentLine = oneLine(body['last-assistant-message']);
		// Codex reports no prompt of its own: the turn it completes is the prompt (so the stop is news).
		return [
			{ source: 'hook', event: 'prompt', at: at - 1, ...(userLine ? { userLine } : {}) },
			{ source: 'hook', event: 'stop', at, ...(agentLine ? { agentLine } : {}) }
		];
	}
	const name = asString(body.hook_event_name);
	switch (name) {
		case 'SessionStart':
			return [{ source: 'hook', event: 'session-start', at }];
		case 'UserPromptSubmit': {
			const userLine = oneLine(body.prompt);
			return [{ source: 'hook', event: 'prompt', at, ...(userLine ? { userLine } : {}) }];
		}
		case 'PermissionRequest': {
			const tool = asString(body.tool_name) ?? 'a tool';
			const suggestions = Array.isArray(body.permission_suggestions) && body.permission_suggestions.length > 0;
			const toolUseId = asString(body.tool_use_id);
			return [
				{
					source: 'hook',
					event: 'permission',
					at,
					prompt: oneLine(`Allow ${describeToolUse(tool, body.tool_input)}?`, FLEET_SESSION_PROMPT_MAX_CHARS),
					tool: tool.slice(0, 64),
					options: claudePermissionOptions(suggestions),
					...(toolUseId ? { promptId: toolUseId } : {})
				}
			];
		}
		case 'PreToolUse': {
			if (body.tool_name !== 'AskUserQuestion') return [];
			const question = claudeQuestion(body.tool_input);
			const toolUseId = asString(body.tool_use_id);
			return [
				{
					source: 'hook',
					event: 'question',
					at,
					...(question.prompt ? { prompt: question.prompt } : {}),
					options: question.options,
					allowsText: true,
					...(toolUseId ? { promptId: toolUseId } : {})
				}
			];
		}
		case 'PostToolUse':
			return [{ source: 'hook', event: 'working', at }];
		case 'Notification': {
			const kind = asString(body.notification_type);
			const message = asString(body.message) ?? '';
			if (kind === 'permission_prompt' || (!kind && /permission/i.test(message))) {
				return [
					{
						source: 'hook',
						event: 'permission',
						at,
						confirmOnly: true,
						prompt: oneLine(message, FLEET_SESSION_PROMPT_MAX_CHARS) ?? ''
					}
				];
			}
			if (kind === 'idle_prompt' || (!kind && /waiting for your input/i.test(message))) {
				return [{ source: 'hook', event: 'idle-prompt', at }];
			}
			return [];
		}
		case 'Stop': {
			const agentLine =
				oneLine(body.last_assistant_message) ??
				(await readLastAssistantLine(body.transcript_path, options.homedir, options.readTail));
			return [{ source: 'hook', event: 'stop', at, ...(agentLine ? { agentLine } : {}) }];
		}
		case 'SessionEnd':
			return [{ source: 'hook', event: 'session-end', at }];
		default:
			return [];
	}
}
