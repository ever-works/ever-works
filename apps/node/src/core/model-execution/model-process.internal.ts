import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

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
	| 'termination-failed'
	| 'credential-boundary-unavailable'
	| 'containment-unavailable';

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
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export type ModelExecutionAuthentication =
	| { readonly kind: 'local-session' }
	| {
			readonly kind: 'provider-credential';
			readonly environment: Readonly<Record<string, string>>;
	  };

type ModelExecutionAuthenticationRequest =
	| {
			readonly authentication: ModelExecutionAuthentication;
			readonly credentialEnv?: never;
	  }
	| {
			/** @deprecated Raw provider secrets are refused until a task-scoped broker exists. */
			readonly authentication?: never;
			readonly credentialEnv: Readonly<Record<string, string>>;
	  };

export type ModelExecutionRequest =
	| (BaseModelExecutionRequest &
			ModelExecutionAuthenticationRequest & {
				readonly provider: 'claude-code';
				readonly options?: ClaudeModelExecutionOptions;
			})
	| (BaseModelExecutionRequest &
			ModelExecutionAuthenticationRequest & {
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
	readonly cleanupFailed?: true;
}

export interface ModelCliCommand {
	/** Canonical absolute path from node-owned configuration; never task input or PATH lookup. */
	readonly executable: string;
	/** Optional CLI-owned auth/config directory for a locally authenticated service identity. */
	readonly localSessionHome?: string;
}

interface ModelExecutionIo {
	/**
	 * Trusted node-owned executable configuration. The node operator must keep
	 * these canonical paths outside task-writable roots and protect them from
	 * the task identity; this executor rechecks stable file identity after the
	 * credential-free probe. Missing provider entries are refused.
	 */
	readonly commands?: Partial<Record<ModelExecutionProvider, ModelCliCommand>>;
	readonly parentEnv?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly spawnFn?: typeof spawn;
	readonly processKill?: typeof process.kill;
	readonly directoryExists?: (path: string) => boolean | Promise<boolean>;
	readonly now?: () => number;
	readonly monotonicNow?: () => number;
	/** Test-only scheduling seam; never exported by the production model-process API. */
	readonly beforeSpawn?: (purpose: 'version-probe' | 'model') => void;
	/** Test-only cleanup seam; never exported by the production model-process API. */
	readonly removeRunRoot?: (path: string) => Promise<void>;
	/**
	 * Internal containment integration seam. The production factory deliberately
	 * supplies none until an audited native launcher can create a suspended child,
	 * assign it to a kill-on-close Job Object, and only then resume it.
	 */
	readonly createModelProcessContainment?: (testSpawn: typeof spawn) => Promise<ModelProcessContainment>;
}

export class ModelExecutionRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelExecutionRequestError';
	}
}

export class ModelExecutionCleanupError extends Error {
	constructor() {
		super('The isolated model run directory could not be removed after bounded retries');
		this.name = 'ModelExecutionCleanupError';
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

/** Security floors enforced against node-owned managed binaries before credentials are supplied. */
export const MODEL_CLI_COMPATIBILITY = {
	'claude-code': { minimumVersion: '2.1.169' },
	codex: { minimumVersion: '0.120.0', accessTokenMinimumVersion: '0.146.0' }
} as const;

const TERMINATION_SETTLE_MS = 2500;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 2000;
const MODEL_RUN_ROOT_CLEANUP_ATTEMPTS = 3;
const MODEL_RUN_ROOT_CLEANUP_ATTEMPT_TIMEOUT_MS = 250;
const MODEL_CLI_VERSION_PROBE_TIMEOUT_MS = 10_000;
const CREDENTIALED_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]+@/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PROXY_ENV_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);

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

interface SelectedCredential {
	readonly name: string;
	readonly value: string;
}

type ResolvedAuthentication =
	| { readonly kind: 'local-session' }
	| { readonly kind: 'provider-credential'; readonly credential: SelectedCredential };

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

interface ModelProcessContainment {
	/** Must return only after the child is assigned to the containment boundary and resumed. */
	readonly spawn: typeof spawn;
	/** Kill-on-close must cover every descendant, including detached children. */
	readonly close: () => Promise<ProcessTreeTermination>;
}

interface ManagedExecutableIdentity {
	readonly canonicalPath: string;
	readonly device: number;
	readonly inode: number;
	readonly size: number;
	readonly modifiedAtMs: number;
	readonly changedAtMs: number;
}

type ParsedModelOutput =
	| { readonly status: 'succeeded'; readonly summary: string }
	| { readonly status: 'model-failed'; readonly summary: string }
	| { readonly status: 'malformed-output'; readonly summary: string };

class ExecutionDeadlineExceeded extends Error {}
class ExecutionCancelled extends Error {}

/**
 * Run one provider CLI in an already-provisioned workspace.
 *
 * This function deliberately stops at a terminal process result. It does not
 * provision repositories, mutate AgentRun/Task state, commit Git changes,
 * push branches, or report the Fleet job.
 */
/** @internal Test/runtime boundary. Import the safe factory from model-process.ts in production. */
export async function executeModelProcessInternal(
	request: ModelExecutionRequest,
	io: ModelExecutionIo
): Promise<ModelExecutionResult> {
	const now = io.now ?? Date.now;
	const monotonicNow = io.monotonicNow ?? (() => performance.now());
	if (request.signal?.aborted) {
		return terminalResult(request.provider, 'cancelled', 0);
	}

	const startedAt = now();
	const timeoutMs = validateRequestTimeout(request.timeoutMs);
	const deadlineAt = monotonicNow() + timeoutMs;
	let secrets: readonly string[] = [];

	let runRoot: string | null = null;
	const execute = async (): Promise<ModelExecutionResult> => {
		try {
			await withinExecutionDeadline(() => validateRequest(request, io), deadlineAt, monotonicNow, request.signal);
			const authentication = resolveAuthentication(request);
			const credential = authentication.kind === 'provider-credential' ? authentication.credential : null;
			if (credential) {
				secrets = [credential.value];
				return credentialBoundaryUnavailableResult(request.provider, Math.max(0, now() - startedAt));
			}
			const trusted = await withinExecutionDeadline(
				() =>
					resolveTrustedCommand(
						request.provider,
						request.workspacePath,
						io.commands,
						io.platform ?? process.platform
					),
				deadlineAt,
				monotonicNow,
				request.signal
			);
			runRoot = await withinExecutionDeadline(
				() => mkdtemp(join(tmpdir(), 'ever-works-model-process-')),
				deadlineAt,
				monotonicNow,
				request.signal
			);
			const configHome = join(runRoot, request.provider === 'claude-code' ? 'claude' : 'codex');
			const isolatedHome = join(runRoot, 'home');
			const isolatedTemp = join(runRoot, 'tmp');
			await withinExecutionDeadline(
				() =>
					Promise.all(
						[
							configHome,
							isolatedTemp,
							join(isolatedHome, 'AppData', 'Roaming'),
							join(isolatedHome, 'AppData', 'Local'),
							join(isolatedHome, '.cache'),
							join(isolatedHome, '.config'),
							join(isolatedHome, '.local', 'share'),
							join(isolatedHome, '.local', 'state')
						].map((path) => mkdir(path, { recursive: true }))
					),
				deadlineAt,
				monotonicNow,
				request.signal
			);

			const env = buildModelEnvironment(
				request.provider,
				credential,
				trusted.localSessionHome ?? configHome,
				isolatedHome,
				isolatedTemp,
				io.parentEnv ?? process.env
			);
			const probeBudgetMs = remainingExecutionMs(deadlineAt, monotonicNow);
			if (probeBudgetMs <= 0) {
				return executionDeadlineResult(request.provider, Math.max(0, now() - startedAt));
			}

			const versionRaw = await runProcess(
				{
					purpose: 'version-probe',
					executable: trusted.command.executable,
					args: ['--version'],
					cwd: trusted.workspacePath,
					env: withoutProviderCredentials(env),
					stdin: '',
					timeoutMs: Math.min(probeBudgetMs, MODEL_CLI_VERSION_PROBE_TIMEOUT_MS),
					deadlineAt,
					monotonicNow,
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
			if (
				!(await withinExecutionDeadline(
					() => managedExecutableIdentityMatches(trusted.identity),
					deadlineAt,
					monotonicNow,
					request.signal
				))
			) {
				return incompatibleCliResult(
					request.provider,
					versionRaw,
					Math.max(0, now() - startedAt),
					'Managed model executable identity changed between its version probe and credentialed run'
				);
			}
			if ((io.platform ?? process.platform) !== 'win32' || !io.createModelProcessContainment) {
				return containmentUnavailableResult(request.provider, Math.max(0, now() - startedAt));
			}
			let containment: ModelProcessContainment;
			try {
				containment = await withinExecutionDeadline(
					() => io.createModelProcessContainment!(io.spawnFn ?? spawn),
					deadlineAt,
					monotonicNow,
					request.signal
				);
			} catch (error) {
				if (error instanceof ExecutionDeadlineExceeded || error instanceof ExecutionCancelled) throw error;
				return containmentUnavailableResult(request.provider, Math.max(0, now() - startedAt));
			}
			const modelBudgetMs = remainingExecutionMs(deadlineAt, monotonicNow);
			if (modelBudgetMs <= 0) {
				return executionDeadlineResult(request.provider, Math.max(0, now() - startedAt));
			}

			const args = buildProviderArgs(request);

			const raw = await runProcess(
				{
					purpose: 'model',
					executable: trusted.command.executable,
					args,
					cwd: trusted.workspacePath,
					env,
					stdin: request.instructions,
					timeoutMs: modelBudgetMs,
					deadlineAt,
					monotonicNow,
					signal: request.signal
				},
				io,
				containment
			);

			return toTerminalResult(request.provider, raw, Math.max(0, now() - startedAt), secrets);
		} catch (error) {
			if (error instanceof ExecutionDeadlineExceeded) {
				return executionDeadlineResult(request.provider, Math.max(0, now() - startedAt));
			}
			if (error instanceof ExecutionCancelled) {
				return terminalResult(request.provider, 'cancelled', Math.max(0, now() - startedAt));
			}
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
		}
	};

	let result: ModelExecutionResult | undefined;
	let executionFailure: unknown;
	let executionFailed = false;
	try {
		result = await execute();
	} catch (error) {
		executionFailed = true;
		executionFailure = error;
	}

	if (runRoot) {
		try {
			await removeIsolatedRunRoot(runRoot, io.removeRunRoot);
		} catch {
			if (result) return cleanupFailedResult(result);
			throw new ModelExecutionCleanupError();
		}
	}
	if (executionFailed) throw executionFailure;
	if (!result) throw new ModelExecutionCleanupError();
	return result;
}

function cleanupFailedResult(result: ModelExecutionResult): ModelExecutionResult {
	return enforceTerminalBudget({
		...result,
		cleanupFailed: true,
		summary: `${result.summary ? `${result.summary}; ` : ''}isolated model run directory cleanup failed after bounded retries`
	});
}

async function removeIsolatedRunRoot(
	runRoot: string,
	removeRunRoot: ((path: string) => Promise<void>) | undefined
): Promise<void> {
	const remove = removeRunRoot ?? ((path: string) => rm(path, { recursive: true, force: true }));
	for (let attempt = 1; attempt <= MODEL_RUN_ROOT_CLEANUP_ATTEMPTS; attempt += 1) {
		const removed = await boundedCleanupAttempt(() => remove(runRoot));
		if (removed) return;
		if (attempt === MODEL_RUN_ROOT_CLEANUP_ATTEMPTS) throw new ModelExecutionCleanupError();
	}
}

function boundedCleanupAttempt(operation: () => Promise<void>): Promise<boolean> {
	return new Promise<boolean>((resolvePromise) => {
		let settled = false;
		const finish = (removed: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(removed);
		};
		const timer = setTimeout(() => finish(false), MODEL_RUN_ROOT_CLEANUP_ATTEMPT_TIMEOUT_MS);
		Promise.resolve()
			.then(operation)
			.then(
				() => finish(true),
				() => finish(false)
			);
	});
}

async function withinExecutionDeadline<T>(
	operation: () => PromiseLike<T>,
	deadlineAt: number,
	monotonicNow: () => number,
	signal?: AbortSignal
): Promise<T> {
	if (signal?.aborted) throw new ExecutionCancelled();
	const remainingMs = remainingExecutionMs(deadlineAt, monotonicNow);
	if (remainingMs <= 0) throw new ExecutionDeadlineExceeded();

	return new Promise<T>((resolvePromise, rejectPromise) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => rejectPromise(new ExecutionCancelled()));
		const timer = setTimeout(() => finish(() => rejectPromise(new ExecutionDeadlineExceeded())), remainingMs);
		signal?.addEventListener('abort', onAbort, { once: true });
		Promise.resolve()
			.then(operation)
			.then(
				(value) => finish(() => resolvePromise(value)),
				(error) => finish(() => rejectPromise(error))
			);
		if (signal?.aborted) onAbort();
	});
}

function remainingExecutionMs(deadlineAt: number, now: () => number): number {
	return Math.max(0, Math.floor(deadlineAt - now()));
}

function executionDeadlineResult(provider: ModelExecutionProvider, durationMs: number): ModelExecutionResult {
	return enforceTerminalBudget({
		provider,
		status: 'timed-out',
		exitCode: null,
		signal: null,
		durationMs,
		summary: 'Model execution exhausted its wall-clock budget before the next process could start',
		outputTruncated: false
	});
}

function containmentUnavailableResult(provider: ModelExecutionProvider, durationMs: number): ModelExecutionResult {
	return enforceTerminalBudget({
		provider,
		status: 'containment-unavailable',
		exitCode: null,
		signal: null,
		durationMs,
		summary:
			'Verified process containment is unavailable: a trusted pre-spawn Windows Job Object launcher must assign the suspended child before it can run',
		outputTruncated: false
	});
}

function credentialBoundaryUnavailableResult(
	provider: ModelExecutionProvider,
	durationMs: number
): ModelExecutionResult {
	return enforceTerminalBudget({
		provider,
		status: 'credential-boundary-unavailable',
		exitCode: null,
		signal: null,
		durationMs,
		summary:
			'Raw provider credentials are refused for Fleet model execution; use a locally authenticated CLI session or a task-scoped credential broker',
		outputTruncated: false
	});
}

function validateRequestTimeout(timeoutMs: number | undefined): number {
	const resolved = timeoutMs ?? MODEL_EXECUTION_DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(resolved) || resolved <= 0 || resolved > MODEL_EXECUTION_MAX_TIMEOUT_MS) {
		throw new ModelExecutionRequestError('Model timeout is outside the Fleet execution bounds');
	}
	return resolved;
}

async function validateRequest(request: ModelExecutionRequest, io: ModelExecutionIo): Promise<void> {
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

	validateProviderOptions(request);
}

async function defaultDirectoryExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function resolveTrustedCommand(
	provider: ModelExecutionProvider,
	workspacePath: string,
	commands: ModelExecutionIo['commands'],
	platform: NodeJS.Platform
): Promise<{
	readonly command: ModelCliCommand;
	readonly workspacePath: string;
	readonly localSessionHome?: string;
	readonly identity: ManagedExecutableIdentity;
}> {
	const command = commands?.[provider];
	const configuredExecutable = command?.executable.trim();
	if (!command || !configuredExecutable || !isAbsolute(configuredExecutable)) {
		throw new ModelExecutionRequestError(`A trusted absolute executable path must be configured for ${provider}`);
	}
	if (Object.keys(command).some((key) => key !== 'executable' && key !== 'localSessionHome')) {
		throw new ModelExecutionRequestError(
			`Managed ${provider} command configuration may contain only its executable path and local session home`
		);
	}

	let canonicalExecutable: string;
	let canonicalWorkspace: string;
	try {
		[canonicalExecutable, canonicalWorkspace] = await Promise.all([
			realpath(configuredExecutable),
			realpath(workspacePath)
		]);
	} catch {
		throw new ModelExecutionRequestError(
			`The trusted executable and workspace for ${provider} must resolve to existing canonical paths`
		);
	}

	if (!pathsEqual(resolve(configuredExecutable), resolve(canonicalExecutable), platform)) {
		throw new ModelExecutionRequestError(`The trusted executable path configured for ${provider} is not canonical`);
	}
	const fromWorkspace = relative(canonicalWorkspace, canonicalExecutable);
	if (!fromWorkspace || (!fromWorkspace.startsWith('..') && !isAbsolute(fromWorkspace))) {
		throw new ModelExecutionRequestError(
			`The trusted executable for ${provider} must not be located inside the leased task workspace`
		);
	}
	let canonicalLocalSessionHome: string | undefined;
	if (command.localSessionHome !== undefined) {
		if (!isAbsolute(command.localSessionHome)) {
			throw new ModelExecutionRequestError(`The local ${provider} session home must be an absolute path`);
		}
		try {
			canonicalLocalSessionHome = await realpath(command.localSessionHome);
		} catch {
			throw new ModelExecutionRequestError(`The local ${provider} session home must resolve to an existing path`);
		}
		if (!pathsEqual(resolve(command.localSessionHome), resolve(canonicalLocalSessionHome), platform)) {
			throw new ModelExecutionRequestError(`The local ${provider} session home is not canonical`);
		}
		const authFromWorkspace = relative(canonicalWorkspace, canonicalLocalSessionHome);
		if (!authFromWorkspace || (!authFromWorkspace.startsWith('..') && !isAbsolute(authFromWorkspace))) {
			throw new ModelExecutionRequestError(
				`The local ${provider} session home must be outside the leased workspace`
			);
		}
	}

	return {
		command: { executable: canonicalExecutable, localSessionHome: canonicalLocalSessionHome },
		workspacePath: canonicalWorkspace,
		localSessionHome: canonicalLocalSessionHome,
		identity: await readManagedExecutableIdentity(canonicalExecutable)
	};
}

async function readManagedExecutableIdentity(canonicalPath: string): Promise<ManagedExecutableIdentity> {
	const metadata = await stat(canonicalPath);
	if (!metadata.isFile()) {
		throw new ModelExecutionRequestError('Managed model executable must resolve to a regular file');
	}
	return {
		canonicalPath,
		device: metadata.dev,
		inode: metadata.ino,
		size: metadata.size,
		modifiedAtMs: metadata.mtimeMs,
		changedAtMs: metadata.ctimeMs
	};
}

async function managedExecutableIdentityMatches(expected: ManagedExecutableIdentity): Promise<boolean> {
	try {
		const currentPath = await realpath(expected.canonicalPath);
		const current = await readManagedExecutableIdentity(currentPath);
		return (
			pathsEqual(current.canonicalPath, expected.canonicalPath, process.platform) &&
			current.device === expected.device &&
			current.inode === expected.inode &&
			current.size === expected.size &&
			current.modifiedAtMs === expected.modifiedAtMs &&
			current.changedAtMs === expected.changedAtMs
		);
	} catch {
		return false;
	}
}

function pathsEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
	return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
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

function resolveAuthentication(request: ModelExecutionRequest): ResolvedAuthentication {
	if (request.authentication && request.credentialEnv !== undefined) {
		throw new ModelExecutionRequestError(
			'Model authentication modes are exclusive; a local session cannot include a raw credential environment'
		);
	}
	if (request.authentication?.kind === 'local-session') return { kind: 'local-session' };
	const credentialEnv =
		request.authentication?.kind === 'provider-credential'
			? request.authentication.environment
			: request.credentialEnv;
	return {
		kind: 'provider-credential',
		credential: selectCredential(request.provider, credentialEnv)
	};
}

function selectCredential(
	provider: ModelExecutionProvider,
	credentialEnv: Readonly<Record<string, string>> | undefined
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
	credential: SelectedCredential | null,
	configHome: string,
	isolatedHome: string,
	isolatedTemp: string,
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
		if (typeof value !== 'string' || !isSafeForwardedEnvironmentValue(requested, value)) return;
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
	env.TEMP = isolatedTemp;
	env.TMP = isolatedTemp;
	env.TMPDIR = isolatedTemp;
	env.CI = '1';
	if (credential) {
		const childCredentialName =
			provider === 'codex' && credential.name === 'OPENAI_API_KEY' ? 'CODEX_API_KEY' : credential.name;
		env[childCredentialName] = credential.value;
	}

	if (provider === 'claude-code') {
		env.CLAUDE_CONFIG_DIR = configHome;
		env.DISABLE_AUTOUPDATER = '1';
		env.DISABLE_TELEMETRY = '1';
	} else {
		env.CODEX_HOME = configHome;
	}
	return env;
}

function isSafeForwardedEnvironmentValue(name: string, value: string): boolean {
	if (CREDENTIALED_URL_PATTERN.test(value)) return false;
	if (!PROXY_ENV_NAMES.has(name.toUpperCase())) return true;

	let proxy: URL;
	try {
		proxy = new URL(value);
	} catch {
		return false;
	}
	if (proxy.username || proxy.password || proxy.search || proxy.hash) return false;
	return true;
}

function hasEnvironmentName(env: Record<string, string>, name: string): boolean {
	const upper = name.toUpperCase();
	return Object.keys(env).some((key) => key.toUpperCase() === upper);
}

function buildProviderArgs(request: ModelExecutionRequest): string[] {
	if (request.provider === 'claude-code') {
		const options = request.options ?? {};
		const args = [
			'--safe-mode',
			'--print',
			'--output-format',
			'json',
			'--no-session-persistence',
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
	const args = ['exec', '--json', '--ephemeral', '--color', 'never', '-c', 'shell_environment_policy.inherit=none'];
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
	credential: SelectedCredential | null,
	raw: RawProcessResult,
	durationMs: number,
	secrets: readonly string[]
): ModelExecutionResult | { readonly version: string } {
	if (raw.termination || raw.spawnError) {
		return toTerminalResult(provider, raw, durationMs, secrets);
	}
	const version = parseCliVersion(provider, raw.stdout || raw.stderr);
	if (raw.exitCode !== 0 || !version) {
		const label = provider === 'claude-code' ? 'Claude Code' : 'Codex';
		return incompatibleCliResult(
			provider,
			raw,
			durationMs,
			raw.exitCode !== 0
				? `${label} version probe failed`
				: `Unrecognized ${label} version response from the managed executable`
		);
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
		credential?.name === 'CODEX_ACCESS_TOKEN' &&
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

function parseCliVersion(provider: ModelExecutionProvider, output: string): string | null {
	if (Buffer.byteLength(output, 'utf8') > 128) return null;
	const pattern =
		provider === 'claude-code'
			? /^(\d{1,6})\.(\d{1,6})\.(\d{1,6}) \(Claude Code\)$/u
			: /^codex-cli (\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u;
	const match = pattern.exec(output.trim());
	return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
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
	return enforceTerminalBudget({
		provider,
		status: 'incompatible-cli',
		exitCode: raw.exitCode,
		signal: raw.signal,
		durationMs,
		summary,
		outputTruncated: raw.outputTruncated
	});
}

async function runProcess(
	options: {
		readonly purpose: 'version-probe' | 'model';
		readonly executable: string;
		readonly args: string[];
		readonly cwd: string;
		readonly env: Record<string, string>;
		readonly stdin: string;
		readonly timeoutMs: number;
		readonly deadlineAt: number;
		readonly monotonicNow: () => number;
		readonly signal?: AbortSignal;
	},
	io: ModelExecutionIo,
	containment?: ModelProcessContainment
): Promise<RawProcessResult> {
	const spawnFn = io.spawnFn ?? spawn;
	const platform = io.platform ?? process.platform;
	let child: ChildProcess;
	let processTimeoutMs: number;
	const closeBeforeSpawn = async (raw: RawProcessResult): Promise<RawProcessResult> => {
		if (!containment) return raw;
		const outcome = await boundedProcessTreeTermination(() => containment.close());
		return outcome.verified
			? raw
			: {
					...raw,
					terminationFailure: outcome.detail ?? 'The unused process containment boundary could not be closed'
				};
	};
	try {
		if (options.signal?.aborted) return closeBeforeSpawn(rawPreSpawnTermination('cancelled'));
		let remainingMs = remainingExecutionMs(options.deadlineAt, options.monotonicNow);
		if (remainingMs <= 0) return closeBeforeSpawn(rawPreSpawnTermination('timed-out'));
		io.beforeSpawn?.(options.purpose);
		if (options.signal?.aborted) return closeBeforeSpawn(rawPreSpawnTermination('cancelled'));
		remainingMs = remainingExecutionMs(options.deadlineAt, options.monotonicNow);
		if (remainingMs <= 0) return closeBeforeSpawn(rawPreSpawnTermination('timed-out'));
		processTimeoutMs = Math.min(options.timeoutMs, remainingMs);
		child = (containment?.spawn ?? spawnFn)(options.executable, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: false,
			windowsHide: true,
			detached: platform !== 'win32'
		});
	} catch (error) {
		return closeBeforeSpawn(rawSpawnFailure(error));
	}

	return new Promise<RawProcessResult>((resolve) => {
		let settled = false;
		let termination: RawProcessResult['termination'] = null;
		let outputTruncated = false;
		let capturedBytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let terminationAttempt: Promise<ProcessTreeTermination> | null = null;
		let terminationFailure: string | null = null;

		const finish = (result: Pick<RawProcessResult, 'exitCode' | 'signal' | 'spawnError'>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
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

		const makeAbsoluteDeadlineWin = (): void => {
			if (!termination && remainingExecutionMs(options.deadlineAt, options.monotonicNow) <= 0) {
				termination = 'timed-out';
			}
		};

		const finishAfterTermination = (result: Pick<RawProcessResult, 'exitCode' | 'signal' | 'spawnError'>): void => {
			const attempt = terminationAttempt;
			if (!attempt) {
				makeAbsoluteDeadlineWin();
				finish(result);
				return;
			}
			void attempt.then(
				(outcome) => {
					recordTermination(outcome);
					makeAbsoluteDeadlineWin();
					finish(result);
				},
				(error) => {
					recordTerminationError(error);
					makeAbsoluteDeadlineWin();
					finish(result);
				}
			);
		};

		const startTreeSafety = (): Promise<ProcessTreeTermination> => {
			if (!terminationAttempt) {
				terminationAttempt = boundedProcessTreeTermination(() =>
					containment
						? containment.close()
						: terminateProcessTree(
								child,
								platform,
								spawnFn,
								io.processKill ?? process.kill,
								withoutProviderCredentials(options.env)
							)
				);
			}
			return terminationAttempt;
		};

		const requestTermination = (reason: NonNullable<RawProcessResult['termination']>): void => {
			if (termination || settled) return;
			termination = reason;
			void startTreeSafety().then(
				(outcome) => {
					recordTermination(outcome);
					finish({ exitCode: null, signal: null, spawnError: null });
				},
				(error) => {
					recordTerminationError(error);
					finish({ exitCode: null, signal: null, spawnError: null });
				}
			);
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
			if (containment) {
				void startTreeSafety();
				finishAfterTermination({ exitCode: null, signal: null, spawnError: error });
				return;
			}
			finish({ exitCode: null, signal: null, spawnError: error });
		});
		child.once('close', (code, signal) => {
			if (!termination && remainingExecutionMs(options.deadlineAt, options.monotonicNow) <= 0) {
				termination = 'timed-out';
			}
			if (containment) void startTreeSafety();
			finishAfterTermination({ exitCode: code, signal, spawnError: null });
		});

		const onAbort = (): void => requestTermination('cancelled');
		const timeoutTimer = setTimeout(() => requestTermination('timed-out'), processTimeoutMs);
		options.signal?.addEventListener('abort', onAbort, { once: true });
		if (options.signal?.aborted) onAbort();

		child.stdin?.on('error', () => undefined);
		child.stdin?.end(options.stdin, 'utf8');
	});
}

function boundedProcessTreeTermination(
	operation: () => Promise<ProcessTreeTermination>
): Promise<ProcessTreeTermination> {
	return new Promise<ProcessTreeTermination>((resolvePromise) => {
		let settled = false;
		const finish = (outcome: ProcessTreeTermination): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(outcome);
		};
		const timer = setTimeout(
			() =>
				finish({
					verified: false,
					detail: 'The process containment close did not settle before its safety deadline'
				}),
			TERMINATION_SETTLE_MS
		);
		Promise.resolve()
			.then(operation)
			.then(
				(outcome) => finish(outcome),
				(error) =>
					finish({
						verified: false,
						detail: `The process containment close failed: ${error instanceof Error ? error.message : String(error)}`
					})
			);
	});
}

function rawPreSpawnTermination(termination: 'timed-out' | 'cancelled'): RawProcessResult {
	return {
		exitCode: null,
		signal: null,
		stdout: '',
		stderr: '',
		outputTruncated: false,
		termination,
		terminationFailure: null,
		spawnError: null
	};
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
		let treeKillerExecutable: string;
		try {
			treeKillerExecutable = await resolveWindowsTreeKiller(env);
		} catch (error) {
			try {
				child.kill('SIGKILL');
			} catch {
				// A root-only fallback cannot certify that descendants are gone.
			}
			return {
				verified: false,
				detail: `Windows tree-killer validation failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
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
				killer = spawnFn(treeKillerExecutable, ['/PID', String(pid), '/T', '/F'], {
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
		} catch {
			try {
				child.kill('SIGKILL');
			} catch {
				// A root-only fallback cannot certify that descendants are gone.
			}
		}
	} else {
		try {
			child.kill('SIGKILL');
		} catch {
			// A root-only fallback cannot certify that descendants are gone.
		}
	}
	return {
		verified: false,
		detail: 'POSIX detached descendant termination cannot be verified by process-group signaling'
	};
}

async function resolveWindowsTreeKiller(env: Record<string, string>): Promise<string> {
	const systemRoot = environmentValue(env, 'SystemRoot');
	if (!systemRoot || !isAbsolute(systemRoot)) {
		throw new Error('SystemRoot is missing or is not absolute');
	}

	const canonicalRoot = await realpath(systemRoot);
	const canonicalSystem32 = await realpath(join(canonicalRoot, 'System32'));
	const candidate = join(canonicalSystem32, 'taskkill.exe');
	const canonicalTaskkill = await realpath(candidate);
	if (!pathsEqual(resolve(candidate), resolve(canonicalTaskkill), 'win32')) {
		throw new Error('System taskkill path is not canonical');
	}
	if (!pathsEqual(join(canonicalSystem32, 'taskkill.exe'), canonicalTaskkill, 'win32')) {
		throw new Error('System taskkill resolved outside System32');
	}
	return canonicalTaskkill;
}

function environmentValue(env: Record<string, string>, name: string): string | undefined {
	const upper = name.toUpperCase();
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
	return key ? env[key] : undefined;
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
	if (raw.termination) {
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
		outputTruncated: true,
		...(bounded.cleanupFailed ? { cleanupFailed: true as const } : {})
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
