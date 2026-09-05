import { execFile, spawn } from 'child_process';
import { statSync } from 'fs';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, relative, resolve, sep } from 'path';
import type { FleetAcceptanceChecksPayload, FleetJobView } from '@ever-works/contracts';
import { resolveExclusiveAgentCredentials } from '@ever-works/contracts';

/**
 * The `acceptance-checks` executor — the node's v1 job kind.
 *
 * ## Why this kind first
 *
 * An acceptance check is, definitionally, "a command and an exit code".
 * That makes it the one unit of platform work a node can execute
 * *completely and correctly* today:
 *
 *   - no model access, no platform credentials, nothing to leak;
 *   - the verdict rules are already specified by the platform contract
 *     (`TaskAcceptanceCheck` / `TaskCheckResult`) rather than invented
 *     here;
 *   - the verdict is observed by the process supervisor (real exit
 *     codes), so it cannot be argued with.
 *
 * The verdict semantics below MIRROR `TaskGateRunnerService` in
 * `packages/agent` exactly — exit 0 → `green`, nonzero → `red`, killed
 * at its timeout → `timeout`, unspawnable → `error`; the gate is red iff
 * any REQUIRED check is not green; checks run sequentially in declared
 * order. A node that scored checks differently from the platform would
 * be worse than a node that ran nothing.
 *
 * ## The executor seam
 *
 * Everything above the `spawn` is generic: the worker loop resolves a
 * handler by `job.kind` and reports whatever it returns. Adding a second
 * kind (full agent execution, terminal sessions, workspace provisioning)
 * is a new module registered against the same seam — no protocol change,
 * no new endpoint, no new credential.
 *
 * ## Environment
 *
 * The child env is built FROM SCRATCH, never inherited. A check command
 * is user-authored input, and a fleet node is somebody's actual laptop:
 * inheriting the process environment would hand every check whatever
 * that machine happens to have exported. This mirrors `buildCheckEnv` in
 * `packages/agent/src/tasks-domain/check-env.ts`.
 */

/** Wall-clock budget applied when a check declares no `timeoutSec`. */
export const DEFAULT_CHECK_TIMEOUT_SEC = 600;

/** Hard per-check ceiling, so a typo'd `timeoutSec` cannot pin a node forever. */
export const MAX_CHECK_TIMEOUT_SEC = 1800;

/** Last-N-bytes window of combined stdout/stderr kept as `logTail`. */
export const CHECK_LOG_TAIL_BYTES = 4096;

/** Upper bound on how many checks one job may carry. */
export const MAX_CHECKS_PER_JOB = 32;

/** Verdict of one check. Mirrors the platform's `TaskCheckResult.status`. */
export type NodeCheckStatus = 'green' | 'red' | 'timeout' | 'error';

/** Gate verdict for the whole job. Mirrors the platform's `GateStatus`. */
export type NodeGateStatus = 'green' | 'red' | 'none';

export interface NodeCheckResult {
	id: string;
	status: NodeCheckStatus;
	exitCode: number | null;
	durationMs: number;
	logTail?: string;
}

export interface AcceptanceChecksOutcome extends Record<string, unknown> {
	gateStatus: NodeGateStatus;
	results: NodeCheckResult[];
}

/** One check as it arrives on the wire. Validated before anything is spawned. */
export interface WireCheck {
	id: string;
	command: string;
	cwd?: string;
	timeoutSec?: number;
	required?: boolean;
	envPassthrough?: string[];
	/**
	 * Per-repository env grants (self-build slice Y): env var NAMES an
	 * operator explicitly bound to a repository of this run, which open the
	 * platform-owned refusal for those EXACT names and nothing adjacent.
	 */
	envGrants?: string[];
}

/** Injected so the whole executor is testable without spawning processes. */
export interface AcceptanceChecksIo {
	spawnFn?: typeof spawn;
	/** Test/embedding seam; production uses an OS-native whole-tree kill. */
	terminateProcessTree?: (child: ReturnType<typeof spawn>) => Promise<void>;
	/** Directory-existence probe; defaults to a real `statSync`. */
	directoryExists?: (path: string) => boolean;
	parentEnv?: NodeJS.ProcessEnv;
	now?: () => number;
}

export class AcceptanceChecksPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AcceptanceChecksPayloadError';
	}
}

/**
 * Run one `acceptance-checks` job to a gate verdict.
 *
 * Throws only on a payload the node CANNOT honour (missing workspace,
 * malformed checks). Everything else — a check that fails, times out or
 * cannot be spawned — is a normal result, because those are verdicts the
 * platform asked for, not errors in the node.
 */
export async function runAcceptanceChecksJob(
	job: FleetJobView,
	io: AcceptanceChecksIo = {},
	signal?: AbortSignal
): Promise<AcceptanceChecksOutcome> {
	throwIfCommandAborted(signal);
	const payload = job.payload as unknown as FleetAcceptanceChecksPayload | null;
	if (!payload || typeof payload !== 'object') {
		throw new AcceptanceChecksPayloadError('Job payload is missing');
	}

	const workspacePath = typeof payload.workspacePath === 'string' ? payload.workspacePath.trim() : '';
	if (!workspacePath) {
		throw new AcceptanceChecksPayloadError('Job payload has no workspacePath');
	}
	if (!isAbsolute(workspacePath)) {
		// A relative workspace would resolve against whatever directory the
		// node service happens to have been started in. Refusing is the only
		// safe reading: a check that runs in the wrong place is worse than a
		// job that fails fast.
		throw new AcceptanceChecksPayloadError('workspacePath must be an absolute path on the node');
	}
	const exists = io.directoryExists ?? defaultDirectoryExists;
	if (!exists(workspacePath)) {
		throw new AcceptanceChecksPayloadError(`workspacePath does not exist on this node: ${workspacePath}`);
	}

	const checks = normalizeChecks(payload.checks);
	if (checks.length === 0) {
		// No checks is not a pass and not a failure — it is nothing to run.
		throwIfCommandAborted(signal);
		return { gateStatus: 'none', results: [] };
	}

	const results: NodeCheckResult[] = [];
	for (const check of checks) {
		throwIfCommandAborted(signal);
		results.push(await executeCheck(check, workspacePath, io, signal));
		throwIfCommandAborted(signal);
	}

	const anyRequiredFailed = checks.some(
		(check, index) => check.required !== false && results[index].status !== 'green'
	);
	throwIfCommandAborted(signal);
	return { gateStatus: anyRequiredFailed ? 'red' : 'green', results };
}

/**
 * Validate the wire checks. A malformed entry is REFUSED rather than
 * skipped: silently dropping a check would turn a red gate green.
 */
export function normalizeChecks(raw: unknown): WireCheck[] {
	if (!Array.isArray(raw)) {
		throw new AcceptanceChecksPayloadError('Job payload `checks` must be an array');
	}
	if (raw.length > MAX_CHECKS_PER_JOB) {
		throw new AcceptanceChecksPayloadError(
			`Job carries ${raw.length} checks; the per-job ceiling is ${MAX_CHECKS_PER_JOB}`
		);
	}
	return raw.map((entry, index) => {
		if (!entry || typeof entry !== 'object') {
			throw new AcceptanceChecksPayloadError(`Check at index ${index} is not an object`);
		}
		const check = entry as Record<string, unknown>;
		const id = typeof check.id === 'string' ? check.id.trim() : '';
		const command = typeof check.command === 'string' ? check.command.trim() : '';
		if (!id) {
			throw new AcceptanceChecksPayloadError(`Check at index ${index} has no id`);
		}
		if (!command) {
			throw new AcceptanceChecksPayloadError(`Check '${id}' has no command`);
		}
		const out: WireCheck = { id, command };
		if (typeof check.cwd === 'string' && check.cwd.trim()) out.cwd = check.cwd.trim();
		if (typeof check.timeoutSec === 'number') out.timeoutSec = check.timeoutSec;
		if (typeof check.required === 'boolean') out.required = check.required;
		if (Array.isArray(check.envPassthrough)) {
			out.envPassthrough = check.envPassthrough.filter((n): n is string => typeof n === 'string');
		}
		return out;
	});
}

function defaultDirectoryExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Spawn one check and observe its real exit code.
 *
 * `shell: true` — a check is authored the way package scripts are
 * (`pnpm build`, `npm test -- --ci`), so it gets the platform shell.
 * That is the whole point of enrolling a machine: it runs the owner's
 * commands. The env scrub below is what keeps that from also meaning
 * "it runs them with everything this machine has exported".
 */
async function executeCheck(
	check: WireCheck,
	rootCwd: string,
	io: AcceptanceChecksIo,
	signal?: AbortSignal
): Promise<NodeCheckResult> {
	const spawnFn = io.spawnFn ?? spawn;
	const now = io.now ?? (() => Date.now());
	const cwd = await resolveStepCwd(rootCwd, check.cwd);
	const timeoutSec = Math.min(
		typeof check.timeoutSec === 'number' && check.timeoutSec > 0 ? check.timeoutSec : DEFAULT_CHECK_TIMEOUT_SEC,
		MAX_CHECK_TIMEOUT_SEC
	);
	const startedAt = now();

	return new Promise<NodeCheckResult>((settle, reject) => {
		let settled = false;
		let timedOut = false;
		let cancelled = false;
		let tail = '';
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;

		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			if (signal && abortListener) signal.removeEventListener('abort', abortListener);
		};

		const finish = (status: NodeCheckStatus, exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			settle({
				id: check.id,
				exitCode,
				status,
				durationMs: now() - startedAt,
				...(tail.length > 0 ? { logTail: tail } : {})
			});
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		if (signal?.aborted) {
			fail(commandAbortError(signal));
			return;
		}

		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn(check.command, {
				cwd,
				shell: true,
				detached: process.platform !== 'win32',
				windowsHide: true,
				env: buildNodeCheckEnv(check.envPassthrough, io.parentEnv, check.envGrants)
			});
		} catch (error) {
			tail = error instanceof Error ? error.message : String(error);
			finish('error', null);
			return;
		}

		const terminate = io.terminateProcessTree ?? terminateNodeProcessTree;
		let termination: Promise<void> | null = null;
		const ensureTerminated = (): Promise<void> => {
			termination ??= Promise.resolve().then(() => terminate(child));
			return termination;
		};
		const destroyPipes = (): void => {
			child.stdout?.destroy();
			child.stderr?.destroy();
		};

		abortListener = () => {
			if (settled || cancelled) return;
			cancelled = true;
			void ensureTerminated().then(
				() => {
					destroyPipes();
					fail(commandAbortError(signal));
				},
				(error: unknown) => fail(processTreeTerminationError(error))
			);
		};
		signal?.addEventListener('abort', abortListener, { once: true });
		if (signal?.aborted) abortListener();

		timer = setTimeout(() => {
			timedOut = true;
			void ensureTerminated().then(
				() => {
					destroyPipes();
					if (cancelled) fail(commandAbortError(signal));
					else finish('timeout', null);
				},
				(error: unknown) => fail(processTreeTerminationError(error))
			);
		}, timeoutSec * 1000);

		const append = (chunk: Buffer | string): void => {
			tail = (tail + chunk.toString()).slice(-CHECK_LOG_TAIL_BYTES);
		};
		child.stdout?.on('data', append);
		child.stderr?.on('data', append);

		// Spawn failures (nonexistent cwd, missing shell) surface here, not
		// as a throw — 'error' keeps infra problems from reading as code
		// problems.
		child.on('error', (error: Error) => {
			append(`\n${error.message}`);
			if (cancelled || timedOut) return;
			finish('error', null);
		});

		// Timeout/cancellation settle from the whole-tree terminator rather
		// than process events: a killed shell can leave a grandchild holding
		// these pipes open, and the job must not wait for it.
		child.on('exit', () => {
			if (cancelled || timedOut) return;
		});

		child.on('close', (code: number | null) => {
			if (cancelled || timedOut) return;
			if (code === 0) {
				finish('green', 0);
			} else {
				// Killed by an external signal (code null) is still not a pass.
				finish('red', code);
			}
		});
	});
}

/** Resolve an explicit step directory without permitting aliases or escape. */
async function resolveStepCwd(rootCwd: string, declared: string | undefined): Promise<string> {
	if (!declared) return rootCwd;
	if (isAbsolute(declared)) {
		throw new AcceptanceChecksPayloadError('Step cwd must be relative to the isolated workspace');
	}
	const lexicalRoot = resolve(rootCwd);
	const lexicalCandidate = resolve(lexicalRoot, declared);
	if (!isStrictDescendantPath(lexicalRoot, lexicalCandidate)) {
		throw new AcceptanceChecksPayloadError('Step cwd escapes the isolated workspace');
	}

	let canonicalRoot: string;
	let canonicalCandidate: string;
	try {
		const candidateStats = await fs.lstat(lexicalCandidate);
		if (candidateStats.isSymbolicLink() || !candidateStats.isDirectory()) {
			throw new Error('link or non-directory');
		}
		[canonicalRoot, canonicalCandidate] = await Promise.all([
			fs.realpath(lexicalRoot),
			fs.realpath(lexicalCandidate)
		]);
	} catch {
		throw new AcceptanceChecksPayloadError('Step cwd is missing, linked, or not a directory');
	}
	const canonicalDeclaredCandidate = resolve(canonicalRoot, relative(lexicalRoot, lexicalCandidate));
	if (
		!sameFilesystemPath(canonicalCandidate, canonicalDeclaredCandidate) ||
		!isStrictDescendantPath(canonicalRoot, canonicalCandidate)
	) {
		throw new AcceptanceChecksPayloadError('Step cwd resolves through a link or outside the isolated workspace');
	}
	return canonicalCandidate;
}

function isStrictDescendantPath(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sameFilesystemPath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const resolved = resolve(value);
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};
	return normalize(left) === normalize(right);
}

/**
 * THE command runner every node job kind goes through.
 *
 * Exported so a second kind (`agent-task`) executes its steps with the
 * SAME env scrub, the same timeout policy and the same exit-code
 * semantics as an acceptance check. A node that ran the two kinds
 * through two subtly-different runners would be a node whose verdicts
 * depend on which queue the work arrived on.
 */
export function runNodeCommandStep(
	step: WireCheck,
	rootCwd: string,
	io: AcceptanceChecksIo = {},
	signal?: AbortSignal
): Promise<NodeCheckResult> {
	return executeCheck(step, rootCwd, io, signal);
}

/** Terminate the shell and every descendant without constructing a shell command. */
export async function terminateNodeProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
	const pid = child.pid;
	if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
		throw new Error('Spawned command has no valid process id for tree termination');
	}

	let primaryError: unknown;
	try {
		if (process.platform === 'win32') {
			await new Promise<void>((resolve, reject) => {
				execFile(
					'taskkill',
					['/PID', String(pid), '/T', '/F'],
					{
						windowsHide: true,
						timeout: PROCESS_EXIT_VERIFY_TIMEOUT_MS,
						maxBuffer: 1024 * 1024
					},
					(error) => (error ? reject(error) : resolve())
				);
			});
			await waitForProcessGone(pid!);
			return;
		}
		process.kill(-pid!, 'SIGKILL');
		await waitForProcessGroupGone(pid!);
		return;
	} catch (error) {
		primaryError = error;
	}

	// A best-effort direct-child kill is still worth doing after the native
	// whole-tree mechanism fails. On POSIX the process-group probe below can
	// prove the entire detached group is gone. On Windows a root-only fallback
	// can never prove descendants, so it deliberately still rejects and causes
	// the WorkerLoop to quarantine itself rather than leasing more work.
	let fallbackError: unknown;
	try {
		const requested = child.kill('SIGKILL');
		if (!requested && isProcessAlive(pid!)) {
			throw new Error('direct child kill was refused while the process remained alive');
		}
		await waitForProcessGone(pid!);
		if (process.platform === 'win32') {
			throw new Error('Windows direct-child fallback cannot prove descendant termination');
		}
		await waitForProcessGroupGone(pid!);
		return;
	} catch (error) {
		fallbackError = error;
	}

	throw new Error(
		`native whole-tree termination failed (${errorDetail(primaryError)}); fallback could not prove the tree gone (${errorDetail(fallbackError)})`
	);
}

const PROCESS_EXIT_VERIFY_TIMEOUT_MS = 2_000;
const PROCESS_EXIT_VERIFY_POLL_MS = 20;

async function waitForProcessGone(pid: number): Promise<void> {
	await waitForGone(() => isProcessAlive(pid), `process ${pid} remained alive after termination`);
}

async function waitForProcessGroupGone(pid: number): Promise<void> {
	await waitForGone(() => isProcessGroupAlive(pid), `process group ${pid} remained alive after termination`);
}

async function waitForGone(isAlive: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + PROCESS_EXIT_VERIFY_TIMEOUT_MS;
	while (isAlive()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_EXIT_VERIFY_POLL_MS));
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function throwIfCommandAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw commandAbortError(signal);
}

function commandAbortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	const error = new Error(reason instanceof Error ? reason.message : 'Fleet command execution was cancelled');
	error.name = 'AbortError';
	return error;
}

function processTreeTerminationError(error: unknown): Error {
	const detail = error instanceof Error ? error.message : String(error);
	const failure = new Error(`Fleet command process tree could not be terminated: ${detail}`);
	failure.name = 'ProcessTreeTerminationError';
	return failure;
}

/**
 * Names a check subprocess may see. Same rule as the platform's
 * allowlist: it must be needed to RESOLVE AND RUN commands (toolchain
 * discovery, locale, temp space) and must not carry credentials.
 */
export const NODE_CHECK_ENV_ALLOWLIST: readonly string[] = [
	'PATH',
	'HOME',
	'SHELL',
	'USER',
	'LOGNAME',
	'TERM',
	'TZ',
	'TMPDIR',
	'LANG',
	'LANGUAGE',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'SystemRoot',
	'SystemDrive',
	'ComSpec',
	'PATHEXT',
	'windir',
	'TEMP',
	'TMP',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'ALLUSERSPROFILE',
	'PROGRAMDATA',
	'PROGRAMFILES',
	'PROGRAMFILES(X86)',
	'COMMONPROGRAMFILES',
	'PUBLIC',
	'USERNAME',
	'COMPUTERNAME',
	'NUMBER_OF_PROCESSORS',
	'PROCESSOR_ARCHITECTURE',
	'OS',
	'NODE_ENV',
	'NODE_VERSION',
	'NODE_OPTIONS',
	'NODE_EXTRA_CA_CERTS',
	'NVM_DIR',
	'NVM_BIN',
	'VOLTA_HOME',
	'COREPACK_HOME',
	'PNPM_HOME',
	'BUN_INSTALL',
	'JAVA_HOME',
	'GOPATH',
	'GOROOT',
	'CARGO_HOME',
	'RUSTUP_HOME',
	'DOTNET_ROOT',
	'VIRTUAL_ENV',
	'PYENV_ROOT',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'REQUESTS_CA_BUNDLE',
	'CURL_CA_BUNDLE',
	'CI'
];

/** Open-ended POSIX locale family. */
export const NODE_CHECK_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_'];

/** Secret-shaped NAMES, dropped unless explicitly granted by the check. */
export const NODE_SECRETISH_ENV_KEY_PATTERN =
	/(SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|DSN|DATABASE_URL|CONNECTION)/i;

/**
 * Namespaces that are NEVER grantable — not by the allowlist, not by an
 * explicit `envPassthrough`. On a fleet node this additionally covers
 * the node's OWN credential namespace: a check must never be able to
 * read the secret that lets this machine lease work.
 */
export const NODE_PLATFORM_OWNED_ENV_PATTERN =
	/^(DATABASE_|PLATFORM_|PLUGIN_|TRIGGER_|AUTH_|BETTER_AUTH_|EVER_WORKS_|FLEET_|SMTP_|RESEND_|MAILER_|STRIPE_|SENTRY_|POSTHOG_|JITSU_|TWENTY_CRM_|K8S_|STORAGE_|AWS_|REDIS_|S3_|MINIO_|GH_|GOOGLE_|FACEBOOK_|LINKEDIN_)/i;

/**
 * The subset of the above that stays refused even WITH an explicit
 * per-repository grant (self-build slice Y).
 *
 * `FLEET_` and `EVER_WORKS_` are this node's own credential namespace: a
 * grant there would let model-driven code read the secret that leases
 * work on this machine and then lease, complete or cancel jobs as the
 * node. `PLUGIN_` holds the key that decrypts every tenant's env files.
 * `AUTH_` / `BETTER_AUTH_` / `PLATFORM_` sign platform sessions. None of
 * them is ever what an operator means by "let my test suite reach the
 * database", so refusing them costs nothing and closes the escalation
 * from "read one secret" to "become the platform".
 *
 * Mirrors `FLEET_RUN_ENV_UNGRANTABLE_PATTERN` in `@ever-works/contracts`;
 * kept as a local literal so the refusal survives even if the payload,
 * the platform, or the contracts package is the thing that is wrong.
 */
export const NODE_UNGRANTABLE_ENV_PATTERN = /^(FLEET_|EVER_WORKS_|PLUGIN_|AUTH_|BETTER_AUTH_|PLATFORM_)/i;

const NODE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_PASSTHROUGH = 32;
const CREDENTIALED_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]+@/i;

/**
 * Build the environment for one check subprocess. Never returns the
 * parent environment, a copy of it, or a spread of it — only the
 * allowlisted names, the explicit grants, and the defaults.
 */
export function buildNodeCheckEnv(
	passthrough?: readonly string[] | null,
	parentEnv: NodeJS.ProcessEnv = process.env,
	/**
	 * Per-repository env grants (self-build slice Y). Env var NAMES an
	 * operator bound to a repository of THIS run, which may pass the
	 * platform-owned refusal below. Absent / empty = today's behaviour
	 * exactly: every platform-owned name is refused.
	 */
	platformOwnedGrants?: readonly string[] | null
): Record<string, string> {
	// Windows env names are case-insensitive (`Path` vs `PATH`), so index
	// the parent once by upper-cased name and look everything up through it.
	const byUpperName = new Map<string, string>();
	for (const key of Object.keys(parentEnv)) {
		const upper = key.toUpperCase();
		if (!byUpperName.has(upper)) byUpperName.set(upper, key);
	}
	const readParent = (name: string): { key: string; value: string } | null => {
		const key = byUpperName.get(name.toUpperCase());
		if (key === undefined) return null;
		const value = parentEnv[key];
		return typeof value === 'string' ? { key, value } : null;
	};

	const env: Record<string, string> = {};

	for (const name of NODE_CHECK_ENV_ALLOWLIST) {
		const found = readParent(name);
		if (found && isSafeInheritedValue(found.key, found.value)) {
			env[found.key] = found.value;
		}
	}
	for (const [upper, key] of byUpperName) {
		if (!NODE_CHECK_ENV_ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()))) {
			continue;
		}
		const value = parentEnv[key];
		if (typeof value === 'string' && isSafeInheritedValue(key, value)) {
			env[key] = value;
		}
	}

	// Explicit per-check grants bypass the secret-name sweep (a listed
	// name IS the grant) but never the platform-owned refusal.
	//
	// Within one CLI these names are prioritised, not interchangeable, and
	// the CLI's own order does not match the operator's intent: Claude Code
	// resolves ANTHROPIC_API_KEY ahead of CLAUDE_CODE_OAUTH_TOKEN and always
	// uses the key in `-p` mode. So on a machine that has both, granting
	// both would bill the Console org for an agent meant to run on a Claude
	// plan — silently. Keep one per family, preferring the
	// subscription-backed credential, and say so in the log.
	// The instance-global passthrough and the per-repository grants meet in
	// exactly ONE place, and the grant set is an explicit argument with an
	// empty default. If the grants ever leaked into the global list, every
	// repository would inherit every repository's grants.
	//
	// A grant is a permission in its own right, not a filter on the
	// passthrough: a name an operator bound to a repository is admitted
	// whether or not the instance-global list also mentions it. The two
	// lists are capped independently (32 each, matching the registry) and
	// merged case-insensitively here, first spelling wins.
	const grants = normalizeGrantedPlatformOwnedNames(platformOwnedGrants);
	const granted: string[] = [];
	const grantedSeen = new Set<string>();
	for (const name of [...normalizePassthrough(passthrough, grants), ...grants]) {
		const upper = name.toUpperCase();
		if (grantedSeen.has(upper)) continue;
		grantedSeen.add(upper);
		granted.push(name);
	}
	const { names: exclusiveNames, notes } = resolveExclusiveAgentCredentials(granted, parentEnv);
	for (const note of notes) {
		// eslint-disable-next-line no-console
		console.warn(`[fleet-node] credential selection — ${note}`);
	}
	for (const name of exclusiveNames) {
		const found = readParent(name);
		if (found) env[found.key] = found.value;
	}

	// `CI=1` is what a headless gate wants: it turns off watch modes and
	// interactive prompts that would otherwise hang a check to its timeout.
	if (!hasName(env, 'CI')) env.CI = '1';
	if (!hasName(env, 'PATH') && process.platform !== 'win32') {
		env.PATH = '/usr/local/bin:/usr/bin:/bin';
	}
	if (!hasName(env, 'HOME') && !hasName(env, 'USERPROFILE')) {
		env.HOME = homedir();
	}
	if (!hasName(env, 'TMPDIR') && !hasName(env, 'TEMP') && !hasName(env, 'TMP')) {
		env.TMPDIR = tmpdir();
	}

	return env;
}

/**
 * Shape-valid, de-duplicated, capped, and platform-owned ONLY where an
 * operator granted that exact name.
 *
 * `platformOwnedGrants` is the keyhole in {@link NODE_PLATFORM_OWNED_ENV_PATTERN},
 * and the whole security of the feature is in one word: EXACT. The
 * refusal pattern is a PREFIX regex, so if a grant were matched by prefix
 * a single `DATABASE_` grant would open `DATABASE_URL`,
 * `DATABASE_PASSWORD` and everything else that starts that way. A grant
 * therefore admits `DATABASE_URL` and NOT `DATABASE_URL_REPLICA`, not
 * `DATABASE_HOST`, not anything adjacent. Case-insensitive because
 * Windows env names are.
 *
 * The un-grantable core (`FLEET_`, `EVER_WORKS_`, `PLUGIN_`, `AUTH_`,
 * `BETTER_AUTH_`, `PLATFORM_`) is stripped from the grant set before it
 * reaches here — see {@link normalizeGrantedPlatformOwnedNames} — so no
 * grant can ever hand a check the credential that leases work on this
 * machine.
 */
export function normalizePassthrough(
	names: readonly string[] | null | undefined,
	platformOwnedGrants?: readonly string[] | null
): string[] {
	if (!Array.isArray(names)) return [];
	const grantedUpper = new Set(
		normalizeGrantedPlatformOwnedNames(platformOwnedGrants).map((name) => name.toUpperCase())
	);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of names) {
		if (typeof raw !== 'string') continue;
		const name = raw.trim();
		if (!NODE_ENV_NAME_PATTERN.test(name)) continue;
		const upper = name.toUpperCase();
		// EXACT-name grant, never a prefix and never a pattern.
		if (NODE_PLATFORM_OWNED_ENV_PATTERN.test(name) && !grantedUpper.has(upper)) continue;
		if (seen.has(upper)) continue;
		seen.add(upper);
		out.push(name);
		if (out.length >= MAX_ENV_PASSTHROUGH) break;
	}
	return out;
}

/**
 * The grant list as this node will actually honour it: shape-valid,
 * wildcard-free, outside the un-grantable core, de-duplicated and capped.
 *
 * Re-derived here rather than trusted from the payload. The platform
 * normalizes grants too, but this is the machine the values live on, and
 * "the platform said so" is not a reason to hand a model-driven process a
 * credential.
 */
export function normalizeGrantedPlatformOwnedNames(names: readonly string[] | null | undefined): string[] {
	if (!Array.isArray(names)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of names) {
		if (typeof raw !== 'string') continue;
		const name = raw.trim();
		if (!NODE_ENV_NAME_PATTERN.test(name)) continue;
		if (name.includes('*') || name.includes('?')) continue;
		if (NODE_UNGRANTABLE_ENV_PATTERN.test(name)) continue;
		const upper = name.toUpperCase();
		if (seen.has(upper)) continue;
		seen.add(upper);
		out.push(name);
		if (out.length >= MAX_ENV_PASSTHROUGH) break;
	}
	return out;
}

function isSafeInheritedValue(name: string, value: string): boolean {
	if (NODE_SECRETISH_ENV_KEY_PATTERN.test(name)) return false;
	if (NODE_PLATFORM_OWNED_ENV_PATTERN.test(name)) return false;
	return !CREDENTIALED_URL_PATTERN.test(value);
}

function hasName(env: Record<string, string>, name: string): boolean {
	const upper = name.toUpperCase();
	return Object.keys(env).some((key) => key.toUpperCase() === upper);
}
