import { spawn } from 'child_process';
import { statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import type { FleetAcceptanceChecksPayload, FleetJobView } from '@ever-works/contracts';

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
}

/** Injected so the whole executor is testable without spawning processes. */
export interface AcceptanceChecksIo {
	spawnFn?: typeof spawn;
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
	io: AcceptanceChecksIo = {}
): Promise<AcceptanceChecksOutcome> {
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
		return { gateStatus: 'none', results: [] };
	}

	const results: NodeCheckResult[] = [];
	for (const check of checks) {
		results.push(await executeCheck(check, workspacePath, io));
	}

	const anyRequiredFailed = checks.some(
		(check, index) => check.required !== false && results[index].status !== 'green'
	);
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
function executeCheck(check: WireCheck, rootCwd: string, io: AcceptanceChecksIo): Promise<NodeCheckResult> {
	const spawnFn = io.spawnFn ?? spawn;
	const now = io.now ?? (() => Date.now());
	const cwd = check.cwd ? join(rootCwd, check.cwd) : rootCwd;
	const timeoutSec = Math.min(
		typeof check.timeoutSec === 'number' && check.timeoutSec > 0 ? check.timeoutSec : DEFAULT_CHECK_TIMEOUT_SEC,
		MAX_CHECK_TIMEOUT_SEC
	);
	const startedAt = now();

	return new Promise<NodeCheckResult>((resolve) => {
		let settled = false;
		let timedOut = false;
		let tail = '';
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (status: NodeCheckStatus, exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				id: check.id,
				exitCode,
				status,
				durationMs: now() - startedAt,
				...(tail.length > 0 ? { logTail: tail } : {})
			});
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn(check.command, {
				cwd,
				shell: true,
				windowsHide: true,
				env: buildNodeCheckEnv(check.envPassthrough, io.parentEnv)
			});
		} catch (error) {
			tail = error instanceof Error ? error.message : String(error);
			finish('error', null);
			return;
		}

		timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill('SIGKILL');
			} catch {
				// Already gone — the close handler settles.
			}
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
			finish('error', null);
		});

		// On timeout, settle on 'exit' (process death) rather than 'close'
		// (stdio drain): a killed shell can leave a grandchild holding the
		// pipes open, and the gate must not wait for it.
		child.on('exit', () => {
			if (timedOut) {
				child.stdout?.destroy();
				child.stderr?.destroy();
				finish('timeout', null);
			}
		});

		child.on('close', (code: number | null) => {
			if (timedOut) {
				finish('timeout', null);
			} else if (code === 0) {
				finish('green', 0);
			} else {
				// Killed by an external signal (code null) is still not a pass.
				finish('red', code);
			}
		});
	});
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
	io: AcceptanceChecksIo = {}
): Promise<NodeCheckResult> {
	return executeCheck(step, rootCwd, io);
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
	parentEnv: NodeJS.ProcessEnv = process.env
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
	for (const name of normalizePassthrough(passthrough)) {
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

/** Shape-valid, de-duplicated, capped, never platform-owned. */
export function normalizePassthrough(names: readonly string[] | null | undefined): string[] {
	if (!Array.isArray(names)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of names) {
		if (typeof raw !== 'string') continue;
		const name = raw.trim();
		if (!NODE_ENV_NAME_PATTERN.test(name)) continue;
		if (NODE_PLATFORM_OWNED_ENV_PATTERN.test(name)) continue;
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
