import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse } from 'node:path';

/** The two local model CLIs a Fleet node currently knows how to run. */
export type ModelExecutionProvider = 'claude-code' | 'codex';

export type ModelExecutionStatus =
	| 'succeeded'
	| 'model-failed'
	| 'process-failed'
	| 'spawn-failed'
	| 'incompatible-cli'
	| 'malformed-output'
	| 'timed-out'
	| 'cancelled'
	| 'output-limit'
	| 'termination-failed';

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ClaudePermissionMode = 'acceptEdits' | 'dontAsk' | 'plan';
export type CodexSandbox = 'read-only' | 'workspace-write';

export interface ClaudeModelExecutionOptions {
	readonly effort?: ClaudeEffort;
	readonly maxBudgetUsd?: number;
	readonly permissionMode?: ClaudePermissionMode;
	/** Must be authorized by the task; the safe default is false. */
	readonly dangerouslySkipPermissions?: boolean;
}

export interface CodexModelExecutionOptions {
	readonly sandbox?: CodexSandbox;
	/** Must be authorized by the task; the safe default is false. */
	readonly dangerouslyBypassApprovalsAndSandbox?: boolean;
}

interface BaseModelExecutionRequest {
	/** Absolute, already-provisioned task workspace. This layer never creates a Git worktree. */
	readonly workspacePath: string;
	/** Prompt/task instructions are written to stdin and never placed on the command line. */
	readonly instructions: string;
	readonly model?: string;
	/** Exactly one provider credential selected from the node's own environment. */
	readonly credentialEnv: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export type ModelExecutionRequest =
	| (BaseModelExecutionRequest & {
			readonly provider: 'claude-code';
			readonly options?: ClaudeModelExecutionOptions;
	  })
	| (BaseModelExecutionRequest & {
			readonly provider: 'codex';
			readonly options?: CodexModelExecutionOptions;
	  });

/** Structured terminal value for a later AgentRun/task/Git reconciliation layer. */
export interface ModelExecutionResult extends Record<string, unknown> {
	readonly provider: ModelExecutionProvider;
	readonly status: ModelExecutionStatus;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly durationMs: number;
	readonly summary?: string;
	readonly stdoutExcerpt?: string;
	readonly stderrExcerpt?: string;
	readonly outputTruncated: boolean;
}

export interface ModelCliCommand {
	readonly executable: string;
	/** Test/packaging adapter only; task payloads never control these arguments. */
	readonly prefixArgs?: readonly string[];
}

export interface ModelExecutionIo {
	readonly commands?: Partial<Record<ModelExecutionProvider, ModelCliCommand>>;
	readonly parentEnv?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly spawnFn?: typeof spawn;
	readonly processKill?: typeof process.kill;
	readonly directoryExists?: (path: string) => boolean | Promise<boolean>;
	readonly now?: () => number;
}

export class ModelExecutionRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelExecutionRequestError';
	}
}

/** Same hard wall-clock ceiling as Fleet command steps. */
export const MODEL_EXECUTION_MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const MODEL_EXECUTION_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MODEL_EXECUTION_MAX_INSTRUCTIONS_BYTES = 1024 * 1024;
/** Combined stdout + stderr retained for parsing before the process is terminated. */
export const MODEL_EXECUTION_OUTPUT_LIMIT_BYTES = 1024 * 1024;
/** Shared serialized terminal-result budget after parsing and secret redaction. */
export const MODEL_EXECUTION_EXCERPT_BYTES = 8 * 1024;

/** Compatibility floor shared with the currently managed generator CLI releases. */
export const MODEL_CLI_COMPATIBILITY = {
	'claude-code': { minimumVersion: '2.1.76' },
	codex: { minimumVersion: '0.120.0', accessTokenMinimumVersion: '0.146.0' }
} as const;

const TERMINATION_SETTLE_MS = 2500;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 2000;
const MODEL_CLI_VERSION_PROBE_TIMEOUT_MS = 10_000;
const CREDENTIALED_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]+@/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

const PROVIDER_CREDENTIALS: Readonly<Record<ModelExecutionProvider, readonly string[]>> = {
	'claude-code': ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
	codex: ['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY']
};

/**
 * Safe host plumbing only. No open-ended credential families, NODE_OPTIONS,
 * GitHub tokens, SSH commands, package-manager tokens or platform namespaces.
 */
const SAFE_SYSTEM_ENV_NAMES: readonly string[] = [
	'PATH',
	'SHELL',
	'USER',
	'LOGNAME',
	'TERM',
	'TZ',
	'TMPDIR',
	'TEMP',
	'TMP',
	'LANG',
	'LANGUAGE',
	'SystemRoot',
	'SystemDrive',
	'ComSpec',
	'PATHEXT',
	'windir',
	'PROGRAMDATA',
	'PROGRAMFILES',
	'PROGRAMFILES(X86)',
	'COMMONPROGRAMFILES',
	'USERNAME',
	'COMPUTERNAME',
	'NUMBER_OF_PROCESSORS',
	'PROCESSOR_ARCHITECTURE',
	'OS',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'REQUESTS_CA_BUNDLE',
	'CURL_CA_BUNDLE'
];

const DEFAULT_COMMANDS: Readonly<Record<ModelExecutionProvider, ModelCliCommand>> = {
	'claude-code': { executable: 'claude' },
	codex: { executable: 'codex' }
};

interface SelectedCredential {
	readonly name: string;
	readonly value: string;
}

interface RawProcessResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly outputTruncated: boolean;
	readonly termination: 'timed-out' | 'cancelled' | 'output-limit' | null;
	readonly terminationFailure: string | null;
	readonly spawnError: Error | null;
}

interface ProcessTreeTermination {
	readonly verified: boolean;
	readonly detail?: string;
}

type ParsedModelOutput =
	| { readonly status: 'succeeded'; readonly summary: string }
	| { readonly status: 'model-failed'; readonly summary: string }
	| { readonly status: 'malformed-output'; readonly summary: string };

/**
 * Run one provider CLI in an already-provisioned workspace.
 *
 * This function deliberately stops at a terminal process result. It does not
 * provision repositories, mutate AgentRun/Task state, commit Git changes,
 * push branches, or report the Fleet job.
 */
export async function executeModelProcess(
	request: ModelExecutionRequest,
	io: ModelExecutionIo = {}
): Promise<ModelExecutionResult> {
	const now = io.now ?? Date.now;
	if (request.signal?.aborted) {
		return terminalResult(request.provider, 'cancelled', 0);
	}

	const startedAt = now();
	const timeoutMs = await validateRequest(request, io);
	if (request.signal?.aborted) {
		return terminalResult(request.provider, 'cancelled', Math.max(0, now() - startedAt));
	}
	const credential = selectCredential(request.provider, request.credentialEnv);
	const secrets = [credential.value];

	let runRoot: string | null = null;
	try {
		runRoot = await mkdtemp(join(tmpdir(), 'ever-works-model-process-'));
		const configHome = join(runRoot, request.provider === 'claude-code' ? 'claude' : 'codex');
		const isolatedHome = join(runRoot, 'home');
		await Promise.all(
			[
				configHome,
				join(isolatedHome, 'AppData', 'Roaming'),
				join(isolatedHome, 'AppData', 'Local'),
				join(isolatedHome, '.cache'),
				join(isolatedHome, '.config'),
				join(isolatedHome, '.local', 'share'),
				join(isolatedHome, '.local', 'state')
			].map((path) => mkdir(path, { recursive: true }))
		);

		const env = buildModelEnvironment(
			request.provider,
			credential,
			configHome,
			isolatedHome,
			io.parentEnv ?? process.env
		);
		const command = io.commands?.[request.provider] ?? DEFAULT_COMMANDS[request.provider];
		if (!command.executable.trim()) {
			throw new ModelExecutionRequestError(`No executable is configured for ${request.provider}`);
		}

		const versionRaw = await runProcess(
			{
				executable: command.executable,
				args: [...(command.prefixArgs ?? []), '--version'],
				cwd: request.workspacePath,
				env: withoutProviderCredentials(env),
				stdin: '',
				timeoutMs: Math.min(timeoutMs, MODEL_CLI_VERSION_PROBE_TIMEOUT_MS),
				signal: request.signal
			},
			io
		);
		const probeResult = resolveCliVersionProbe(
			request.provider,
			credential,
			versionRaw,
			Math.max(0, now() - startedAt),
			secrets
		);
		if ('status' in probeResult) return probeResult;

		const args = [...(command.prefixArgs ?? []), ...buildProviderArgs(request)];

		const raw = await runProcess(
			{
				executable: command.executable,
				args,
				cwd: request.workspacePath,
				env,
				stdin: request.instructions,
				timeoutMs,
				signal: request.signal
			},
			io
		);

		return toTerminalResult(request.provider, raw, Math.max(0, now() - startedAt), secrets);
	} catch (error) {
		if (error instanceof ModelExecutionRequestError) {
			throw error;
		}
		const message = redactBounded(error instanceof Error ? error.message : String(error), secrets);
		return enforceTerminalBudget({
			provider: request.provider,
			status: 'spawn-failed',
			exitCode: null,
			signal: null,
			durationMs: Math.max(0, now() - startedAt),
			summary: message || `Failed to prepare ${request.provider}`,
			outputTruncated: false
		});
	} finally {
		if (runRoot) {
			await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

async function validateRequest(request: ModelExecutionRequest, io: ModelExecutionIo): Promise<number> {
	const workspacePath = request.workspacePath?.trim();
	if (!workspacePath || !isAbsolute(workspacePath)) {
		throw new ModelExecutionRequestError('Model workspacePath must be an absolute path on the node');
	}
	const exists = io.directoryExists ?? defaultDirectoryExists;
	if (!(await exists(workspacePath))) {
		throw new ModelExecutionRequestError('Model workspacePath does not exist on this node');
	}

	if (typeof request.instructions !== 'string' || request.instructions.trim().length === 0) {
		throw new ModelExecutionRequestError('Model instructions must not be empty');
	}
	if (Buffer.byteLength(request.instructions, 'utf8') > MODEL_EXECUTION_MAX_INSTRUCTIONS_BYTES) {
		throw new ModelExecutionRequestError('Model instructions exceed the Fleet byte ceiling');
	}
	if (request.model !== undefined && !MODEL_PATTERN.test(request.model)) {
		throw new ModelExecutionRequestError('Model name has an unsupported shape');
	}

	const timeoutMs = request.timeoutMs ?? MODEL_EXECUTION_DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MODEL_EXECUTION_MAX_TIMEOUT_MS) {
		throw new ModelExecutionRequestError('Model timeout is outside the Fleet execution bounds');
	}

	validateProviderOptions(request);
	return timeoutMs;
}

async function defaultDirectoryExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function validateProviderOptions(request: ModelExecutionRequest): void {
	if (request.provider === 'claude-code') {
		const options = request.options;
		if (
			options?.dangerouslySkipPermissions !== undefined &&
			typeof options.dangerouslySkipPermissions !== 'boolean'
		) {
			throw new ModelExecutionRequestError('Claude dangerous opt-in must be boolean');
		}
		if (options?.effort && !(['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(options.effort)) {
			throw new ModelExecutionRequestError('Claude effort is unsupported');
		}
		if (
			options?.permissionMode &&
			!(['acceptEdits', 'dontAsk', 'plan'] as const).includes(options.permissionMode)
		) {
			throw new ModelExecutionRequestError('Claude permission mode is unsupported');
		}
		if (
			options?.maxBudgetUsd !== undefined &&
			(!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0 || options.maxBudgetUsd > 10_000)
		) {
			throw new ModelExecutionRequestError('Claude budget is outside the execution bounds');
		}
		return;
	}

	if (
		request.options?.dangerouslyBypassApprovalsAndSandbox !== undefined &&
		typeof request.options.dangerouslyBypassApprovalsAndSandbox !== 'boolean'
	) {
		throw new ModelExecutionRequestError('Codex dangerous opt-in must be boolean');
	}
	const sandbox = request.options?.sandbox;
	if (sandbox && !(['read-only', 'workspace-write'] as const).includes(sandbox)) {
		throw new ModelExecutionRequestError('Codex sandbox mode is unsupported');
	}
}

function selectCredential(
	provider: ModelExecutionProvider,
	credentialEnv: Readonly<Record<string, string>>
): SelectedCredential {
	if (!credentialEnv || typeof credentialEnv !== 'object' || Array.isArray(credentialEnv)) {
		throw new ModelExecutionRequestError(`A selected ${provider} credential environment is required`);
	}

	const allowed = PROVIDER_CREDENTIALS[provider];
	const selected: SelectedCredential[] = [];
	const seen = new Set<string>();
	for (const [rawName, value] of Object.entries(credentialEnv)) {
		const canonical = allowed.find((candidate) => candidate.toUpperCase() === rawName.toUpperCase());
		if (!canonical) {
			throw new ModelExecutionRequestError(`Credential '${rawName}' is not allowed for ${provider}`);
		}
		if (seen.has(canonical)) {
			throw new ModelExecutionRequestError(`Credential '${canonical}' was supplied more than once`);
		}
		seen.add(canonical);
		if (typeof value !== 'string' || value.trim().length === 0) {
			throw new ModelExecutionRequestError(`Credential '${canonical}' is empty`);
		}
		selected.push({ name: canonical, value });
	}

	if (selected.length !== 1) {
		throw new ModelExecutionRequestError(
			`Exactly one ${provider} credential must be selected; received ${selected.length}`
		);
	}
	return selected[0];
}

function buildModelEnvironment(
	provider: ModelExecutionProvider,
	credential: SelectedCredential,
	configHome: string,
	isolatedHome: string,
	parentEnv: NodeJS.ProcessEnv
): Record<string, string> {
	const byUpper = new Map<string, string>();
	for (const key of Object.keys(parentEnv)) {
		if (!byUpper.has(key.toUpperCase())) byUpper.set(key.toUpperCase(), key);
	}

	const env: Record<string, string> = {};
	const copy = (requested: string): void => {
		const key = byUpper.get(requested.toUpperCase());
		if (!key) return;
		const value = parentEnv[key];
		if (typeof value !== 'string' || CREDENTIALED_URL_PATTERN.test(value)) return;
		env[key] = value;
	};
	for (const name of SAFE_SYSTEM_ENV_NAMES) copy(name);
	for (const [upper, key] of byUpper) {
		if (!upper.startsWith('LC_')) continue;
		const value = parentEnv[key];
		if (typeof value === 'string' && !CREDENTIALED_URL_PATTERN.test(value)) env[key] = value;
	}

	if (!hasEnvironmentName(env, 'PATH') && process.platform !== 'win32') {
		env.PATH = '/usr/local/bin:/usr/bin:/bin';
	}
	if (!hasEnvironmentName(env, 'TMPDIR') && !hasEnvironmentName(env, 'TEMP') && !hasEnvironmentName(env, 'TMP')) {
		env.TMPDIR = tmpdir();
	}
	const homeRoot = parse(isolatedHome).root;
	const windowsDrive = /^([A-Za-z]:)[\\/]/u.exec(homeRoot)?.[1];
	env.HOME = isolatedHome;
	env.USERPROFILE = isolatedHome;
	env.HOMEDRIVE = windowsDrive ?? homeRoot;
	env.HOMEPATH = windowsDrive ? isolatedHome.slice(windowsDrive.length) : isolatedHome;
	env.APPDATA = join(isolatedHome, 'AppData', 'Roaming');
	env.LOCALAPPDATA = join(isolatedHome, 'AppData', 'Local');
	env.XDG_CACHE_HOME = join(isolatedHome, '.cache');
	env.XDG_CONFIG_HOME = join(isolatedHome, '.config');
	env.XDG_DATA_HOME = join(isolatedHome, '.local', 'share');
	env.XDG_STATE_HOME = join(isolatedHome, '.local', 'state');
	env.CI = '1';
	const childCredentialName =
		provider === 'codex' && credential.name === 'OPENAI_API_KEY' ? 'CODEX_API_KEY' : credential.name;
	env[childCredentialName] = credential.value;

	if (provider === 'claude-code') {
		env.CLAUDE_CONFIG_DIR = configHome;
		env.DISABLE_AUTOUPDATER = '1';
		env.DISABLE_TELEMETRY = '1';
	} else {
		env.CODEX_HOME = configHome;
	}
	return env;
}

function hasEnvironmentName(env: Record<string, string>, name: string): boolean {
	const upper = name.toUpperCase();
	return Object.keys(env).some((key) => key.toUpperCase() === upper);
}

function buildProviderArgs(request: ModelExecutionRequest): string[] {
	if (request.provider === 'claude-code') {
		const options = request.options ?? {};
		const args = [
			'--print',
			'--output-format',
			'json',
			'--no-session-persistence',
			'--setting-sources',
			'project',
			'--strict-mcp-config'
		];
		if (options.dangerouslySkipPermissions) {
			args.push('--dangerously-skip-permissions');
		} else {
			args.push('--permission-mode', options.permissionMode ?? 'acceptEdits');
		}
		if (request.model) args.push('--model', request.model);
		if (options.effort) args.push('--effort', options.effort);
		if (options.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(options.maxBudgetUsd));
		return args;
	}

	const options = request.options ?? {};
	const args = ['exec', '--json', '--ephemeral', '--color', 'never'];
	if (options.dangerouslyBypassApprovalsAndSandbox) {
		args.push('--dangerously-bypass-approvals-and-sandbox');
	} else {
		args.push('--sandbox', options.sandbox ?? 'workspace-write');
	}
	if (request.model) args.push('--model', request.model);
	args.push('--', '-');
	return args;
}

function withoutProviderCredentials(env: Record<string, string>): Record<string, string> {
	const probeEnv = { ...env };
	for (const name of [
		'CLAUDE_CODE_OAUTH_TOKEN',
		'ANTHROPIC_API_KEY',
		'CODEX_ACCESS_TOKEN',
		'CODEX_API_KEY',
		'OPENAI_API_KEY'
	]) {
		delete probeEnv[name];
	}
	return probeEnv;
}

function resolveCliVersionProbe(
	provider: ModelExecutionProvider,
	credential: SelectedCredential,
	raw: RawProcessResult,
	durationMs: number,
	secrets: readonly string[]
): ModelExecutionResult | { readonly version: string } {
	if (raw.termination || raw.spawnError) {
		return toTerminalResult(provider, raw, durationMs, secrets);
	}
	const version = parseCliVersion(raw.stdout || raw.stderr);
	if (raw.exitCode !== 0 || !version) {
		return {
			provider,
			status: 'incompatible-cli',
			exitCode: raw.exitCode,
			signal: raw.signal,
			durationMs,
			summary: raw.exitCode !== 0 ? 'Model CLI version probe failed' : 'Model CLI returned no semantic version',
			outputTruncated: raw.outputTruncated
		};
	}

	const contract = MODEL_CLI_COMPATIBILITY[provider];
	if (compareSemver(version, contract.minimumVersion) < 0) {
		return incompatibleCliResult(
			provider,
			raw,
			durationMs,
			`Detected ${provider} ${version}; minimum supported version is ${contract.minimumVersion}`
		);
	}
	if (
		provider === 'codex' &&
		credential.name === 'CODEX_ACCESS_TOKEN' &&
		compareSemver(version, MODEL_CLI_COMPATIBILITY.codex.accessTokenMinimumVersion) < 0
	) {
		return incompatibleCliResult(
			provider,
			raw,
			durationMs,
			`Detected Codex ${version}; CODEX_ACCESS_TOKEN requires ${MODEL_CLI_COMPATIBILITY.codex.accessTokenMinimumVersion} or newer`
		);
	}
	return { version };
}

function parseCliVersion(output: string): string | null {
	return output.match(/\b(\d+)\.(\d+)\.(\d+)\b/u)?.[0] ?? null;
}

function compareSemver(left: string, right: string): number {
	const leftParts = left.split('.').map(Number);
	const rightParts = right.split('.').map(Number);
	for (let index = 0; index < 3; index += 1) {
		if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
	}
	return 0;
}

function incompatibleCliResult(
	provider: ModelExecutionProvider,
	raw: RawProcessResult,
	durationMs: number,
	summary: string
): ModelExecutionResult {
	return {
		provider,
		status: 'incompatible-cli',
		exitCode: raw.exitCode,
		signal: raw.signal,
		durationMs,
		summary,
		outputTruncated: raw.outputTruncated
	};
}

async function runProcess(
	options: {
		readonly executable: string;
		readonly args: string[];
		readonly cwd: string;
		readonly env: Record<string, string>;
		readonly stdin: string;
		readonly timeoutMs: number;
		readonly signal?: AbortSignal;
	},
	io: ModelExecutionIo
): Promise<RawProcessResult> {
	const spawnFn = io.spawnFn ?? spawn;
	const platform = io.platform ?? process.platform;
	let child: ChildProcess;
	try {
		child = spawnFn(options.executable, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: false,
			windowsHide: true,
			detached: platform !== 'win32'
		});
	} catch (error) {
		return rawSpawnFailure(error);
	}

	return new Promise<RawProcessResult>((resolve) => {
		let settled = false;
		let termination: RawProcessResult['termination'] = null;
		let outputTruncated = false;
		let capturedBytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let fallbackTimer: NodeJS.Timeout | null = null;
		let terminationAttempt: Promise<ProcessTreeTermination> | null = null;
		let terminationFailure: string | null = null;
		let terminationSettled = false;

		const finish = (result: Pick<RawProcessResult, 'exitCode' | 'signal' | 'spawnError'>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
			options.signal?.removeEventListener('abort', onAbort);
			resolve({
				...result,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
				outputTruncated,
				termination,
				terminationFailure
			});
		};

		const recordTermination = (outcome: ProcessTreeTermination): void => {
			terminationSettled = true;
			if (!outcome.verified) {
				terminationFailure = outcome.detail ?? 'The process tree termination outcome could not be verified';
			}
		};

		const recordTerminationError = (error: unknown): void => {
			recordTermination({
				verified: false,
				detail: `The process tree termination attempt failed: ${error instanceof Error ? error.message : String(error)}`
			});
		};

		const finishAfterTermination = (result: Pick<RawProcessResult, 'exitCode' | 'signal' | 'spawnError'>): void => {
			const attempt = terminationAttempt;
			if (!attempt) {
				finish(result);
				return;
			}
			void attempt.then(
				(outcome) => {
					recordTermination(outcome);
					finish(result);
				},
				(error) => {
					recordTerminationError(error);
					finish(result);
				}
			);
		};

		const requestTermination = (reason: NonNullable<RawProcessResult['termination']>): void => {
			if (termination || settled) return;
			termination = reason;
			fallbackTimer = setTimeout(() => {
				if (!terminationSettled) {
					terminationFailure =
						'The process tree termination attempt did not settle before its safety deadline';
				}
				finish({ exitCode: null, signal: null, spawnError: null });
			}, TERMINATION_SETTLE_MS);
			terminationAttempt = terminateProcessTree(
				child,
				platform,
				spawnFn,
				io.processKill ?? process.kill,
				withoutProviderCredentials(options.env)
			);
			void terminationAttempt.then(recordTermination, recordTerminationError);
		};

		const append = (target: Buffer[], chunk: Buffer): void => {
			const remaining = MODEL_EXECUTION_OUTPUT_LIMIT_BYTES - capturedBytes;
			if (remaining <= 0) {
				outputTruncated = true;
				requestTermination('output-limit');
				return;
			}
			const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
			target.push(kept);
			capturedBytes += kept.length;
			if (kept.length < chunk.length) {
				outputTruncated = true;
				requestTermination('output-limit');
			}
		};

		child.stdout?.on('data', (chunk: Buffer | string) => append(stdout, Buffer.from(chunk)));
		child.stderr?.on('data', (chunk: Buffer | string) => append(stderr, Buffer.from(chunk)));
		child.once('error', (error) => {
			if (termination) return;
			finish({ exitCode: null, signal: null, spawnError: error });
		});
		child.once('close', (code, signal) => {
			finishAfterTermination({ exitCode: code, signal, spawnError: null });
		});

		const onAbort = (): void => requestTermination('cancelled');
		const timeoutTimer = setTimeout(() => requestTermination('timed-out'), options.timeoutMs);
		options.signal?.addEventListener('abort', onAbort, { once: true });
		if (options.signal?.aborted) onAbort();

		child.stdin?.on('error', () => undefined);
		child.stdin?.end(options.stdin, 'utf8');
	});
}

function rawSpawnFailure(error: unknown): RawProcessResult {
	return {
		exitCode: null,
		signal: null,
		stdout: '',
		stderr: '',
		outputTruncated: false,
		termination: null,
		terminationFailure: null,
		spawnError: error instanceof Error ? error : new Error(String(error))
	};
}

/** Force the entire process tree down; a timed-out agent must not keep editing. */
async function terminateProcessTree(
	child: ChildProcess,
	platform: NodeJS.Platform,
	spawnFn: typeof spawn,
	processKill: typeof process.kill,
	env: Record<string, string>
): Promise<ProcessTreeTermination> {
	const pid = child.pid;
	if (platform === 'win32' && typeof pid === 'number') {
		return new Promise<ProcessTreeTermination>((resolve) => {
			let killer: ChildProcess;
			let settled = false;
			let watchdog: NodeJS.Timeout | null = null;
			const killRoot = (): void => {
				try {
					child.kill('SIGKILL');
				} catch {
					// A root-only fallback cannot certify that descendants are gone.
				}
			};
			const finish = (outcome: ProcessTreeTermination): void => {
				if (settled) return;
				settled = true;
				if (watchdog) clearTimeout(watchdog);
				resolve(outcome);
			};
			try {
				killer = spawnFn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
					stdio: 'ignore',
					shell: false,
					windowsHide: true,
					env
				} as SpawnOptions);
			} catch (error) {
				killRoot();
				finish({
					verified: false,
					detail: `Windows taskkill could not be spawned: ${error instanceof Error ? error.message : String(error)}`
				});
				return;
			}
			watchdog = setTimeout(() => {
				try {
					killer.kill('SIGKILL');
				} catch {
					// The watchdog outcome remains unverified either way.
				}
				killRoot();
				finish({
					verified: false,
					detail: `Windows taskkill did not settle within ${WINDOWS_TREE_KILL_TIMEOUT_MS} ms`
				});
			}, WINDOWS_TREE_KILL_TIMEOUT_MS);
			killer.once('error', (error) => {
				killRoot();
				finish({
					verified: false,
					detail: `Windows taskkill failed to start: ${error.message}`
				});
			});
			killer.once('close', (code, signal) => {
				if (code === 0) {
					finish({ verified: true });
					return;
				}
				killRoot();
				finish({
					verified: false,
					detail: `Windows taskkill exited with code ${code ?? 'null'}${signal ? ` and signal ${signal}` : ''}`
				});
			});
		});
	}

	if (typeof pid === 'number') {
		try {
			processKill(-pid, 'SIGKILL');
			return { verified: true };
		} catch {
			// The process may have exited between the timeout and this call.
		}
	}
	try {
		child.kill('SIGKILL');
	} catch {
		// A root-only fallback cannot certify that descendants are gone.
	}
	return { verified: false, detail: 'Only the root model process could be targeted' };
}

function toTerminalResult(
	provider: ModelExecutionProvider,
	raw: RawProcessResult,
	durationMs: number,
	secrets: readonly string[]
): ModelExecutionResult {
	const stdoutExcerpt = tailUtf8(
		redactCapturedOutput(raw.stdout, secrets, raw.outputTruncated),
		MODEL_EXECUTION_EXCERPT_BYTES
	);
	const stderrExcerpt = tailUtf8(
		redactCapturedOutput(raw.stderr, secrets, raw.outputTruncated),
		MODEL_EXECUTION_EXCERPT_BYTES
	);
	const base = {
		provider,
		exitCode: raw.exitCode,
		signal: raw.signal,
		durationMs,
		stdoutExcerpt: stdoutExcerpt || undefined,
		stderrExcerpt: stderrExcerpt || undefined,
		outputTruncated: raw.outputTruncated
	};

	if (raw.termination) {
		if (raw.terminationFailure) {
			return enforceTerminalBudget({
				...base,
				status: 'termination-failed',
				summary: redactBounded(
					`Model process tree termination was not verified: ${raw.terminationFailure}`,
					secrets
				)
			});
		}
		return enforceTerminalBudget({
			...base,
			status: raw.termination,
			summary:
				raw.termination === 'timed-out'
					? 'Model execution exceeded its wall-clock limit'
					: raw.termination === 'cancelled'
						? 'Model execution was cancelled'
						: 'Model execution exceeded its output limit'
		});
	}
	if (raw.spawnError) {
		return enforceTerminalBudget({
			...base,
			status: 'spawn-failed',
			summary: redactBounded(raw.spawnError.message, secrets)
		});
	}

	const parsed = parseProviderOutput(provider, raw.stdout);
	if (raw.exitCode !== 0) {
		if (parsed.status === 'model-failed') {
			return enforceTerminalBudget({
				...base,
				status: 'model-failed',
				summary: redactBounded(parsed.summary, secrets)
			});
		}
		return enforceTerminalBudget({
			...base,
			status: 'process-failed',
			summary: stderrExcerpt || `Model CLI exited with code ${raw.exitCode ?? 'null'}`
		});
	}

	return enforceTerminalBudget({
		...base,
		status: parsed.status,
		summary: redactBounded(parsed.summary, secrets)
	});
}

function parseProviderOutput(provider: ModelExecutionProvider, stdout: string): ParsedModelOutput {
	return provider === 'claude-code' ? parseClaudeOutput(stdout) : parseCodexOutput(stdout);
}

function parseClaudeOutput(stdout: string): ParsedModelOutput {
	try {
		const event = JSON.parse(stdout.trim()) as Record<string, unknown>;
		if (!event || event.type !== 'result' || typeof event.is_error !== 'boolean') {
			return { status: 'malformed-output', summary: 'Claude Code returned an unexpected JSON result' };
		}
		const summary = extractText(event.result) ?? extractText(event.error) ?? 'Claude Code completed';
		return event.is_error ? { status: 'model-failed', summary } : { status: 'succeeded', summary };
	} catch {
		return { status: 'malformed-output', summary: 'Claude Code returned malformed JSON output' };
	}
}

function parseCodexOutput(stdout: string): ParsedModelOutput {
	const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
	if (lines.length === 0) {
		return { status: 'malformed-output', summary: 'Codex returned no JSONL events' };
	}

	const events: Record<string, unknown>[] = [];
	for (const line of lines) {
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (!event || typeof event.type !== 'string') throw new Error('event has no type');
			events.push(event);
		} catch {
			return { status: 'malformed-output', summary: 'Codex returned malformed JSONL output' };
		}
	}

	const failure = events.find((event) =>
		['turn.failed', 'item.failed', 'error'].includes(typeof event.type === 'string' ? event.type : '')
	);
	if (failure) {
		return {
			status: 'model-failed',
			summary:
				extractText((failure.error as Record<string, unknown> | undefined)?.message) ??
				extractText(failure.message) ??
				'Codex reported a model or tool failure'
		};
	}

	if (!events.some((event) => event.type === 'turn.completed')) {
		return { status: 'malformed-output', summary: 'Codex JSONL ended without a completed turn' };
	}

	let summary = 'Codex completed';
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const item = events[index].item as Record<string, unknown> | undefined;
		if (item?.type !== 'agent_message') continue;
		const text = extractText(item.text);
		if (text) {
			summary = text;
			break;
		}
	}
	return { status: 'succeeded', summary };
}

function extractText(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function tailUtf8(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, 'utf8');
	if (buffer.length <= maxBytes) return text;
	return buffer.subarray(buffer.length - maxBytes).toString('utf8');
}

function redactKnownSecrets(text: string, secrets: readonly string[]): string {
	let redacted = text;
	for (const secret of secrets) {
		if (secret.length > 0) redacted = redacted.split(secret).join('[redacted]');
	}
	return redacted;
}

function redactBounded(text: string, secrets: readonly string[]): string {
	return tailUtf8(redactKnownSecrets(text, secrets), MODEL_EXECUTION_EXCERPT_BYTES);
}

function redactCapturedOutput(text: string, secrets: readonly string[], mayEndInsideSecret: boolean): string {
	let redacted = redactKnownSecrets(text, secrets);
	if (!mayEndInsideSecret) return redacted;

	for (const secret of secrets) {
		for (let length = Math.min(secret.length - 1, redacted.length); length > 0; length -= 1) {
			if (!redacted.endsWith(secret.slice(0, length))) continue;
			redacted = `${redacted.slice(0, -length)}[redacted]`;
			break;
		}
	}
	return redacted;
}

function enforceTerminalBudget(result: ModelExecutionResult): ModelExecutionResult {
	let bounded = result;
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const serializedBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
		if (serializedBytes <= MODEL_EXECUTION_EXCERPT_BYTES) return bounded;

		const textFields = (['summary', 'stdoutExcerpt', 'stderrExcerpt'] as const)
			.map((field) => ({ field, value: bounded[field] }))
			.filter((entry): entry is { field: 'summary' | 'stdoutExcerpt' | 'stderrExcerpt'; value: string } =>
				Boolean(entry.value)
			)
			.sort((left, right) => Buffer.byteLength(right.value, 'utf8') - Buffer.byteLength(left.value, 'utf8'));
		const largest = textFields[0];
		if (!largest) break;

		const fieldBytes = Buffer.byteLength(largest.value, 'utf8');
		const excess = serializedBytes - MODEL_EXECUTION_EXCERPT_BYTES;
		const nextBytes = Math.max(0, fieldBytes - excess - 32);
		bounded = {
			...bounded,
			[largest.field]: nextBytes > 0 ? tailUtf8(largest.value, nextBytes) : undefined,
			outputTruncated: true
		};
	}

	return {
		provider: bounded.provider,
		status: bounded.status,
		exitCode: bounded.exitCode,
		signal: bounded.signal,
		durationMs: bounded.durationMs,
		outputTruncated: true
	};
}

function terminalResult(
	provider: ModelExecutionProvider,
	status: Extract<ModelExecutionStatus, 'cancelled'>,
	durationMs: number
): ModelExecutionResult {
	return {
		provider,
		status,
		exitCode: null,
		signal: null,
		durationMs,
		summary: 'Model execution was cancelled before spawn',
		outputTruncated: false
	};
}
