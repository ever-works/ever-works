import type { FleetRootShell } from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { IS_ADMIN_SCRIPT, POWERSHELL, powerShellArgs } from './powershell';

/**
 * Machine facts (FL-09, README §3, spec FR-4) — the root rule.
 *
 * Ever Works never types, asks for, stores or transmits a password. An act
 * that needs root runs only when the machine ALREADY lets the node's user do
 * it without one:
 *
 *  - **Unix.** The node is root → plain. Otherwise `sudo -n -- <argv>`: `-n`
 *    makes sudo fail instead of prompting, so a machine whose sudoers does not
 *    allow this exact command answers at once ("a password is required") and
 *    the act is refused with the command for the owner to run themselves —
 *    `sudo systemctl restart nginx`. `-S` (password on stdin) is never
 *    passed, and stdin is never written.
 *  - **Windows.** The node runs elevated → plain. Otherwise the act is
 *    refused at once, with the PowerShell line to run in an elevated window
 *    (`Restart-Service -Name W3SVC`) — there is no non-interactive elevation.
 *
 * A refusal is remembered per command for {@link ROOT_PROBE_CACHE_MS}, so a
 * second click does not re-ask sudo; a success is remembered too, which is
 * what a list row's `preauthorized` shows.
 */

export const ROOT_PROBE_CACHE_MS = 60_000;

/** What sudo prints when `-n` stopped it (sudo 1.8 → 1.9, Linux and macOS). */
const SUDO_REFUSED = [
	/a password is required/i,
	/a terminal is required/i,
	/no tty present/i,
	/askpass/i,
	/is not in the sudoers/i,
	/may not run sudo/i,
	/is not allowed to (run|execute)/i,
	/sorry, user/i,
	/not allowed to execute/i
];

export function isSudoRefusal(stderr: string): boolean {
	return SUDO_REFUSED.some((pattern) => pattern.test(stderr));
}

/** One argv as a person would type it in a POSIX shell (for the hint only — never executed). */
export function renderPosixCommand(argv: readonly string[]): string {
	return argv
		.map((arg) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
		.join(' ');
}

export type RootRunOutcome =
	| {
			ok: true;
			code: number | null;
			stdout: string;
			stderr: string;
			spawnError?: string;
			timedOut?: boolean;
			viaSudo: boolean;
	  }
	| { ok: false; command: string; shell: FleetRootShell };

export interface RootRunRequest {
	/** What runs (`['systemctl', '--no-ask-password', 'restart', 'nginx.service']`). */
	argv: readonly string[];
	/** What the owner would type (`['systemctl', 'restart', 'nginx']`); defaults to {@link argv}. */
	display?: readonly string[];
	/** False: run plain, whoever the node is. */
	needsRoot: boolean;
	timeoutMs?: number;
}

export interface RootRunner {
	/** Run one Unix command, as root when it needs it and the machine already allows it. */
	run(request: RootRunRequest): Promise<RootRunOutcome>;
	/**
	 * Windows: run a PowerShell script that needs administrator rights, or
	 * refuse with {@link displayCommand} when the node is not elevated.
	 */
	runPowerShell(request: {
		script: string;
		displayCommand: string;
		needsAdmin: boolean;
		timeoutMs?: number;
	}): Promise<RootRunOutcome>;
	/** Whether root acts would run right now: true (root / elevated / allowed), false (refused before), null (unknown). */
	preauthorized(argv?: readonly string[]): boolean | null;
	/** True when the node itself is root (Unix) or elevated (Windows, after the first probe). */
	isPrivileged(): Promise<boolean>;
}

export interface RootRunnerOptions {
	runner: CommandRunner;
	platform: string;
	/** `process.getuid?.() === 0`; injected for tests. */
	isRoot?: () => boolean;
	now?: () => number;
}

export function createRootRunner(options: RootRunnerOptions): RootRunner {
	const { runner, platform } = options;
	const now = options.now ?? (() => Date.now());
	const isRoot = options.isRoot ?? (() => typeof process.getuid === 'function' && process.getuid() === 0);
	const decisions = new Map<string, { allowed: boolean; at: number }>();
	let anySudoAllowed: { allowed: boolean; at: number } | null = null;
	let admin: { value: boolean; at: number } | null = null;

	const fresh = (entry: { at: number } | null | undefined): boolean =>
		!!entry && now() - entry.at < ROOT_PROBE_CACHE_MS;

	const isAdmin = async (): Promise<boolean> => {
		if (admin && fresh(admin)) return admin.value;
		const result = await runner.run(POWERSHELL, powerShellArgs(IS_ADMIN_SCRIPT), { timeoutMs: 10_000 });
		const value = result.code === 0 && /^\s*true\s*$/i.test(result.stdout);
		admin = { value, at: now() };
		return value;
	};

	return {
		async run(request) {
			const argv = [...request.argv];
			const display = [...(request.display ?? request.argv)];
			if (argv.length === 0) throw new Error('an empty command');
			if (!request.needsRoot || isRoot()) {
				const result = await runner.run(argv[0], argv.slice(1), { timeoutMs: request.timeoutMs });
				return { ok: true, ...result, viaSudo: false };
			}
			const key = argv.join('\0');
			const command = `sudo ${renderPosixCommand(display)}`;
			const known = decisions.get(key);
			if (known && fresh(known) && !known.allowed) return { ok: false, command, shell: 'sh' };
			const result = await runner.run('sudo', ['-n', '--', ...argv], { timeoutMs: request.timeoutMs });
			if (result.spawnError === 'ENOENT') {
				// No sudo on this machine at all: the owner runs it as root themselves.
				decisions.set(key, { allowed: false, at: now() });
				return { ok: false, command: renderPosixCommand(display), shell: 'sh' };
			}
			if (result.code !== 0 && isSudoRefusal(result.stderr)) {
				decisions.set(key, { allowed: false, at: now() });
				anySudoAllowed =
					anySudoAllowed && fresh(anySudoAllowed) ? anySudoAllowed : { allowed: false, at: now() };
				return { ok: false, command, shell: 'sh' };
			}
			decisions.set(key, { allowed: true, at: now() });
			anySudoAllowed = { allowed: true, at: now() };
			return { ok: true, ...result, viaSudo: true };
		},

		async runPowerShell(request) {
			if (request.needsAdmin && !(await isAdmin())) {
				return { ok: false, command: request.displayCommand, shell: 'powershell' };
			}
			const result = await runner.run(POWERSHELL, powerShellArgs(request.script), {
				timeoutMs: request.timeoutMs
			});
			return { ok: true, ...result, viaSudo: false };
		},

		preauthorized(argv) {
			if (platform === 'win32') return admin && fresh(admin) ? admin.value : null;
			if (isRoot()) return true;
			if (argv) {
				const known = decisions.get(argv.join('\0'));
				if (known && fresh(known)) return known.allowed;
			}
			return anySudoAllowed && fresh(anySudoAllowed) ? anySudoAllowed.allowed : null;
		},

		async isPrivileged() {
			if (platform === 'win32') return isAdmin();
			return isRoot();
		}
	};
}
