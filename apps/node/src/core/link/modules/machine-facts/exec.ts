import { execFile } from 'node:child_process';
import type { CommandRunner } from '../../../capabilities';

/**
 * Machine facts (FL-09) — the one way the services, processes and Docker
 * modules start a child process.
 *
 *  - **argv only, never a shell.** `shell: false` on every platform — unlike
 *    the node's general runner, which uses a shell on Windows to find `.cmd`
 *    shims. Nothing a person typed (a service name, a pid) is ever parsed by
 *    a shell (spec FR-36); PowerShell work goes through `-EncodedCommand`
 *    with every name a validated literal (`powershell.ts`).
 *  - **a scrubbed environment.** The child gets only what a service manager,
 *    `ps` or the Docker CLI needs to find itself and its session (PATH, the
 *    home and user, the systemd user bus, the Windows system folders, the
 *    Docker context) and `LC_ALL=C`, so what it prints parses the same on
 *    every machine. The node's own credentials and the platform's tokens are
 *    never handed down.
 *  - **bounded.** A default deadline and an output cap, so a hung or chatty
 *    tool cannot hold a link request open or fill the node's memory.
 */

/** Environment variables a machine-facts child keeps from the node's own. */
const KEPT_ENV = [
	'PATH',
	'Path',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'TZ',
	'TMPDIR',
	// systemd `--user` needs the user's runtime dir and session bus.
	'XDG_RUNTIME_DIR',
	'DBUS_SESSION_BUS_ADDRESS',
	// Homebrew finds its prefix through these.
	'HOMEBREW_PREFIX',
	'HOMEBREW_CELLAR',
	'HOMEBREW_REPOSITORY',
	// The Docker CLI's own context selection (never a credential).
	'DOCKER_HOST',
	'DOCKER_CONTEXT',
	'DOCKER_CONFIG',
	'DOCKER_CERT_PATH',
	'DOCKER_TLS_VERIFY',
	// Windows.
	'SystemRoot',
	'SYSTEMROOT',
	'windir',
	'WINDIR',
	'ComSpec',
	'COMSPEC',
	'PATHEXT',
	'TEMP',
	'TMP',
	'USERPROFILE',
	'USERNAME',
	'USERDOMAIN',
	'APPDATA',
	'LOCALAPPDATA',
	'ProgramData',
	'PROGRAMDATA',
	'ProgramFiles',
	'PROGRAMFILES',
	'ProgramFiles(x86)',
	'PSModulePath'
] as const;

/** The environment every machine-facts child runs with. */
export function machineChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of KEPT_ENV) {
		const value = parent[key];
		if (typeof value === 'string' && value.length > 0) out[key] = value;
	}
	out.LC_ALL = 'C';
	out.LANG = 'C';
	// `systemctl` and friends must never page or prompt.
	out.SYSTEMD_PAGER = '';
	out.SYSTEMD_COLORS = '0';
	out.PAGER = 'cat';
	return out;
}

/** Default deadline of one machine-facts child. */
export const MACHINE_CHILD_TIMEOUT_MS = 15_000;

/** Most bytes of stdout one child may print before it is cut off. */
export const MACHINE_CHILD_MAX_BUFFER = 16 * 1024 * 1024;

export interface MachineCommandRunnerOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	maxBuffer?: number;
}

/**
 * The `execFile`-backed runner of the machine-facts modules: no shell, a
 * scrubbed environment, a deadline and an output cap. Same shape as the
 * node's `CommandRunner`, so every parser is tested against a fake.
 */
export function createMachineCommandRunner(options: MachineCommandRunnerOptions = {}): CommandRunner {
	const env = options.env ?? machineChildEnv();
	const defaultTimeout = options.timeoutMs ?? MACHINE_CHILD_TIMEOUT_MS;
	const maxBuffer = options.maxBuffer ?? MACHINE_CHILD_MAX_BUFFER;
	return {
		run: (command, args, runOptions) =>
			new Promise((resolve) => {
				const timeout =
					typeof runOptions?.timeoutMs === 'number' &&
					Number.isFinite(runOptions.timeoutMs) &&
					runOptions.timeoutMs > 0
						? runOptions.timeoutMs
						: defaultTimeout;
				execFile(
					command,
					args,
					{ shell: false, windowsHide: true, timeout, maxBuffer, env, encoding: 'utf8' },
					(error, stdout, stderr) => {
						const code = error
							? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? 1)
							: 0;
						resolve({
							code: typeof code === 'number' ? code : 1,
							stdout: String(stdout ?? ''),
							stderr: String(stderr ?? ''),
							...(typeof code === 'string' ? { spawnError: code } : {}),
							timedOut: Boolean(error && (error as { killed?: boolean }).killed)
						});
					}
				);
			})
	};
}

/** The first non-empty line of what a tool printed, for a typed refusal's hint. */
export function firstLine(text: string, fallback: string): string {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.slice(0, 300);
	}
	return fallback;
}
