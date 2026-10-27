import type { UsageDirEntry, UsageFileStat, UsageFs } from '../usage-fs';

/**
 * Usage & cost on the fleet (FL-20) — fixture records and an in-memory
 * filesystem for the scan's specs. Every record carries prompts, outputs,
 * tool results and secret-shaped strings on purpose: the specs assert none of
 * them survive into a report or the scan's own state (spec ACC-FL20-02).
 */

/** Strings that must never appear in a report or the state file. */
export const FORBIDDEN_STRINGS = [
	'PROMPT-please-refactor-the-billing-module',
	'OUTPUT-here-is-the-refactored-code',
	'TOOL-RESULT-cat-etc-passwd',
	'sk-ant-api03-FAKEFAKEFAKEFAKE',
	'ghp_FAKETOKENFAKETOKENFAKETOKEN',
	'INSTRUCTIONS-you-are-codex',
	'REASONING-secret-chain-of-thought'
];

export function claudeLine(input: {
	sessionId: string;
	messageId: string;
	requestId?: string;
	model?: string;
	at: string;
	cwd?: string;
	usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}): string {
	return JSON.stringify({
		parentUuid: null,
		isSidechain: false,
		userType: 'external',
		cwd: input.cwd ?? '/home/owner/code/api',
		sessionId: input.sessionId,
		version: '2.0.0',
		gitBranch: 'main',
		type: 'assistant',
		message: {
			id: input.messageId,
			type: 'message',
			role: 'assistant',
			model: input.model ?? 'claude-sonnet-4-5-20250929',
			content: [
				{ type: 'text', text: 'OUTPUT-here-is-the-refactored-code' },
				{
					type: 'tool_use',
					id: 'toolu_1',
					name: 'Bash',
					input: { command: 'echo sk-ant-api03-FAKEFAKEFAKEFAKE' }
				}
			],
			stop_reason: 'end_turn',
			usage: {
				input_tokens: input.usage.input,
				output_tokens: input.usage.output,
				cache_read_input_tokens: input.usage.cacheRead ?? 0,
				cache_creation_input_tokens: input.usage.cacheWrite ?? 0,
				service_tier: 'standard'
			}
		},
		requestId: input.requestId ?? `req_${input.messageId}`,
		uuid: `uuid-${input.messageId}`,
		timestamp: input.at
	});
}

export function claudeUserLine(sessionId: string, at: string): string {
	return JSON.stringify({
		type: 'user',
		sessionId,
		cwd: '/home/owner/code/api',
		message: { role: 'user', content: 'PROMPT-please-refactor-the-billing-module ghp_FAKETOKENFAKETOKENFAKETOKEN' },
		uuid: `user-${at}`,
		timestamp: at
	});
}

export function claudeToolResultLine(sessionId: string, at: string): string {
	return JSON.stringify({
		type: 'user',
		sessionId,
		message: {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'TOOL-RESULT-cat-etc-passwd' }]
		},
		toolUseResult: { stdout: 'TOOL-RESULT-cat-etc-passwd usage input_tokens assistant' },
		timestamp: at
	});
}

export function codexMetaLine(sessionId: string, at: string, cwd = '/home/owner/code/web'): string {
	return JSON.stringify({
		timestamp: at,
		type: 'session_meta',
		payload: {
			id: sessionId,
			timestamp: at,
			cwd,
			originator: 'codex_cli_rs',
			cli_version: '0.50.0',
			instructions: 'INSTRUCTIONS-you-are-codex'
		}
	});
}

export function codexTurnLine(at: string, model = 'gpt-5-codex'): string {
	return JSON.stringify({
		timestamp: at,
		type: 'turn_context',
		payload: { cwd: '/home/owner/code/web', approval_policy: 'on-request', model, effort: 'medium' }
	});
}

export function codexMessageLine(at: string): string {
	return JSON.stringify({
		timestamp: at,
		type: 'response_item',
		payload: {
			type: 'message',
			role: 'user',
			content: [{ type: 'input_text', text: 'PROMPT-please-refactor-the-billing-module token_count' }]
		}
	});
}

export function codexReasoningLine(at: string): string {
	return JSON.stringify({
		timestamp: at,
		type: 'response_item',
		payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONING-secret-chain-of-thought' }] }
	});
}

export function codexTokenLine(
	at: string,
	total: { input: number; cached: number; output: number },
	last: { input: number; cached: number; output: number } | null
): string {
	const shape = (u: { input: number; cached: number; output: number }) => ({
		input_tokens: u.input,
		cached_input_tokens: u.cached,
		output_tokens: u.output,
		reasoning_output_tokens: 0,
		total_tokens: u.input + u.output
	});
	return JSON.stringify({
		timestamp: at,
		type: 'event_msg',
		payload: {
			type: 'token_count',
			info: {
				total_token_usage: shape(total),
				...(last ? { last_token_usage: shape(last) } : {}),
				model_context_window: 272000
			},
			rate_limits: { primary: { used_percent: 10 } }
		}
	});
}

interface MemoryFile {
	content: Buffer;
	mtimeMs: number;
	link?: boolean;
}

/** An in-memory `UsageFs`: POSIX paths, symlinks as flagged entries, atomic writes recorded. */
export class MemoryUsageFs implements UsageFs {
	readonly files = new Map<string, MemoryFile>();
	readonly dirs = new Set<string>();
	readonly links = new Set<string>();
	opened: string[] = [];
	private clock = 1_000;

	addFile(path: string, content: string, mtimeMs?: number): void {
		this.files.set(path, { content: Buffer.from(content, 'utf8'), mtimeMs: mtimeMs ?? (this.clock += 1) });
		this.addDirChain(path);
	}

	append(path: string, content: string): void {
		const existing = this.files.get(path);
		if (!existing) return this.addFile(path, content);
		existing.content = Buffer.concat([existing.content, Buffer.from(content, 'utf8')]);
		existing.mtimeMs = this.clock += 1;
	}

	remove(path: string): void {
		this.files.delete(path);
	}

	addLink(path: string): void {
		this.links.add(path);
		this.addDirChain(path);
	}

	private addDirChain(path: string): void {
		const parts = path.split('/');
		for (let i = 2; i < parts.length; i += 1) this.dirs.add(parts.slice(0, i).join('/'));
	}

	readdir = async (dir: string): Promise<UsageDirEntry[]> => {
		if (!this.dirs.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		const names = new Set<string>();
		const prefix = `${dir}/`;
		for (const path of [...this.files.keys(), ...this.dirs, ...this.links]) {
			if (!path.startsWith(prefix)) continue;
			names.add(path.slice(prefix.length).split('/')[0]);
		}
		return [...names].map((name) => {
			const path = `${prefix}${name}`;
			const isLink = this.links.has(path);
			const isFile = !isLink && this.files.has(path);
			const isDir = !isLink && !isFile && this.dirs.has(path);
			return { name, isFile: () => isFile, isDirectory: () => isDir, isSymbolicLink: () => isLink };
		});
	};

	lstat = async (path: string): Promise<UsageFileStat> => {
		if (this.links.has(path)) {
			return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
		}
		const file = this.files.get(path);
		if (file) {
			return {
				size: file.content.length,
				mtimeMs: file.mtimeMs,
				isFile: () => true,
				isDirectory: () => false,
				isSymbolicLink: () => false
			};
		}
		if (this.dirs.has(path)) {
			return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
		}
		throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
	};

	realpath = async (path: string): Promise<string> => path;

	exists = (path: string): boolean => this.files.has(path) || this.dirs.has(path);

	openRead = async (path: string) => {
		const file = this.files.get(path);
		if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		this.opened.push(path);
		return {
			read: async (length: number, position: number) =>
				Buffer.from(file.content.subarray(position, Math.min(file.content.length, position + length))),
			close: async () => undefined
		};
	};

	readFile = async (path: string): Promise<string | null> => {
		const file = this.files.get(path);
		return file ? file.content.toString('utf8') : null;
	};

	writeFileAtomic = async (path: string, content: string): Promise<void> => {
		this.addFile(path, content);
	};

	mkdir = async (dir: string): Promise<void> => {
		this.dirs.add(dir);
		this.addDirChain(`${dir}/x`);
	};
}
